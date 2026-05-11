import json
import os
import traceback
from datetime import datetime, timedelta
import pytz
from flask import Flask, jsonify, request
from flask_cors import CORS
import awsgi
import pymysql
import hashlib
import jwt
from functools import wraps
import boto3
from init_db import get_db_conn
from recommendation_engine import RecommendationEngine
import time

app = Flask(__name__)
# CORS 완벽 허용
CORS(app, resources={r"/api/*": {"origins": "*"}})

SECRET_KEY = "scada-super-secret-key"

sqs_client = boto3.client('sqs', region_name='ap-northeast-2')
kinesis_client = boto3.client('kinesis', region_name='ap-northeast-2')
athena_client = boto3.client('athena', region_name='ap-northeast-2')
ce_client = boto3.client('ce', region_name='us-east-1') # Cost Explorer는 us-east-1 고정

# 환경에 맞게 URL과 스트림 이름을 수정해야 함
SQS_QUEUE_URL = 'https://sqs.ap-northeast-2.amazonaws.com/827913617635/factory-lambda-error-dlq'
KINESIS_STREAM_NAME = 'factory_logs'

# 💡 401 및 500 에러 원천 차단: OPTIONS 요청 우회 및 안전한 토큰 검증
def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if request.method == 'OPTIONS':
            return jsonify({"status": "success"}), 200
            
        auth_header = request.headers.get('Authorization')
        if not auth_header or not auth_header.startswith('Bearer '):
            return jsonify({"status": "error", "message": "토큰이 없습니다."}), 401
            
        token = auth_header.split(" ")[1]
        if token == "null" or token == "undefined":
            return jsonify({"status": "error", "message": "잘못된 토큰입니다. 다시 로그인하세요."}), 401
            
        try:
            data = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
            request.user_role = data['role']
        except Exception as e:
            return jsonify({"status": "error", "message": "만료되거나 유효하지 않은 토큰입니다."}), 401
        return f(*args, **kwargs)
    return decorated

@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    if not username or not password:
        return jsonify({"status": "error", "message": "정보를 입력하세요."}), 400
        
    hashed_pw = hashlib.sha256(password.encode()).hexdigest()
    conn = get_db_conn()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute("SELECT role FROM system_users WHERE username = %s AND password_hash = %s", (username, hashed_pw))
            user = cursor.fetchone()
            if user:
                token = jwt.encode({'username': username, 'role': user['role'], 'exp': datetime.utcnow() + timedelta(hours=24)}, SECRET_KEY, algorithm="HS256")
                return jsonify({"status": "success", "token": token, "role": user['role']})
            else:
                return jsonify({"status": "error", "message": "아이디 또는 비밀번호가 틀렸습니다."}), 401
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/dashboard_status')
def get_dashboard_status():
    conn = get_db_conn()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cursor:
            today_str = datetime.now().strftime('%Y-%m-%d')
            current_hour_str = datetime.now().strftime('%H') # 예: '11'
            current_hour_prefix = f"{today_str} {current_hour_str}" # 예: '2026-04-28 11'

            # 각 라인의 '마지막 공정' 동적 식별
            cursor.execute("""
                SELECT line_id, process_id 
                FROM line_process_map
                WHERE (line_id, step_sequence) IN (
                    SELECT line_id, MAX(step_sequence) 
                    FROM line_process_map 
                    GROUP BY line_id
                )
            """)
            last_procs = {row['line_id']: row['process_id'] for row in cursor.fetchall()}
            
            # 초기화
            cursor.execute("SELECT DISTINCT line_id FROM line_process_map")
            res = {row['line_id']: {"produced": 0, "alerts": 0, "target": 1, "processes": {}} for row in cursor.fetchall()}
            
            # 생산량 & 이상치 스캔
            # 💡 [핵심 수정 1] UNION ALL로 과거 데이터와 1초 단위 실시간 데이터를 합산
            cursor.execute("""
                SELECT line_id, process_id, SUM(qty) as qty
                FROM (
                    -- 1. Cold: 오늘 00시 ~ 직전 시간(10시)까지의 확정 데이터
                    SELECT line_id, process_id, total_qty as qty 
                    FROM hourly_stats 
                    WHERE target_hour LIKE %s AND SUBSTRING(target_hour, 12, 2) < %s
                    
                    UNION ALL
                    
                    -- 2. Hot: 오직 현재 시간(11시)의 실시간 데이터만!
                    SELECT line_id, process_id, qty 
                    FROM realtime_line_status 
                    WHERE target_hour LIKE %s
                ) as combined
                GROUP BY line_id, process_id
            """, (f"{today_str}%", current_hour_str, f"{current_hour_prefix}%"))
            
            for row in cursor.fetchall():
                l_id, p_id = row['line_id'], row['process_id']
                if l_id in res:
                    qty = int(row['qty'] or 0)
                    
                    # 💡 [추가] 실시간 각 공정별 생산량을 딕셔너리에 저장
                    res[l_id]['processes'][p_id] = qty 
                    
                    # 라인 총합은 기존처럼 마지막 공정 기준으로만 합산
                    if last_procs.get(l_id) == p_id:
                        res[l_id]['produced'] += qty
                    
            # --- [유지] 알럿(이상치) 개수는 기존 시간당 집계 테이블에서 스캔 ---
            cursor.execute("""
                SELECT w.line_id, w.process_id, COUNT(*) as alerts
                FROM factory_alerts a
                JOIN worker_master w ON a.worker_id = w.worker_id
                WHERE a.created_at LIKE %s
                GROUP BY w.line_id, w.process_id
            """, (f"{today_str}%",))

            for row in cursor.fetchall():
                l_id = row['line_id']
                if l_id in res:
                    res[l_id]['alerts'] += int(row['alerts'] or 0)

            # 목표 생산량 계산
            cursor.execute("""
                SELECT m.line_id, m.process_id, w.current_efficiency, p.base_smv
                FROM line_process_map m
                JOIN worker_master w ON m.worker_id = w.worker_id
                JOIN process_master p ON m.process_id = p.process_id
            """)
            targets_by_line = {}
            
            for r in cursor.fetchall():
                l_id = r['line_id']
                if l_id not in targets_by_line: targets_by_line[l_id] = []
                
                eff = float(r['current_efficiency'] or 0)
                smv = float(r['base_smv'] or 0)
                if smv > 0 and eff > 0:
                    max_qty = int(28800 / (smv / (eff / 100.0)))
                    targets_by_line[l_id].append(max_qty)
            
            for l_id, t_list in targets_by_line.items():
                if t_list and l_id in res:
                    res[l_id]['target'] = min(t_list)

            # 💡 [핵심 수정 2] SELECT만 했어도 반드시 commit()을 해서 트랜잭션 스냅샷을 갱신 (새로고침 버그 해결)
            conn.commit()
            return jsonify({"status": "success", "data": res})
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"status": "error", "message": f"Dashboard Error: {str(e)}"}), 200

@app.route('/api/hourly_production')
def get_hourly_production():
    target_date = request.args.get('date', datetime.now().strftime('%Y-%m-%d'))
    line_id = request.args.get('line_id', 'ALL')
    conn = get_db_conn()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cursor:
            # 마지막 공정 식별 유지
            cursor.execute("""
                SELECT line_id, process_id FROM line_process_map
                WHERE (line_id, step_sequence) IN (SELECT line_id, MAX(step_sequence) FROM line_process_map GROUP BY line_id)
            """)
            last_procs = {row['line_id']: row['process_id'] for row in cursor.fetchall()}
            
            # 💡 [핵심 수정 1] 날짜에 따라 쿼리 분리 (오늘이면 UNION ALL, 과거면 hourly_stats 단독 조회)
            today_str = datetime.now().strftime('%Y-%m-%d')
            current_hour_str = datetime.now().strftime('%H')
            current_hour_prefix = f"{today_str} {current_hour_str}"
            params = []
            
            if target_date == today_str:
                sql = """
                    SELECT SUBSTRING(target_hour, 12, 2) as hour_str, line_id, process_id, SUM(qty) as qty
                    FROM (
                        SELECT target_hour, line_id, process_id, total_qty as qty 
                        FROM hourly_stats 
                        WHERE target_hour LIKE %s AND SUBSTRING(target_hour, 12, 2) < %s
                        
                        UNION ALL
                        
                        SELECT target_hour, line_id, process_id, qty 
                        FROM realtime_line_status 
                        WHERE target_hour LIKE %s
                    ) as combined
                    WHERE 1=1
                """
                params.extend([f"{today_str}%", current_hour_str, f"{current_hour_prefix}%"])
            else:
                # 과거 날짜는 무조건 Cold 테이블만
                sql = """
                    SELECT SUBSTRING(target_hour, 12, 2) as hour_str, line_id, process_id, SUM(total_qty) as qty
                    FROM hourly_stats
                    WHERE target_hour LIKE %s
                """
                params.append(f"{target_date}%")
            
            if line_id != 'ALL':
                sql += " AND line_id = %s"
                params.append(line_id)
                
            sql += " GROUP BY hour_str, line_id, process_id"
            cursor.execute(sql, tuple(params))
            
            res = {}
            for row in cursor.fetchall():
                l_id, p_id, h_str = row['line_id'], row['process_id'], row['hour_str']
                if last_procs.get(l_id) == p_id:
                    res[h_str] = res.get(h_str, 0) + int(row['qty'] or 0)
            
            # 💡 [핵심 수정 2] 트랜잭션 갱신
            conn.commit()
            return jsonify(res)
    except Exception as e:
        return jsonify({"status": "error", "message": f"Hourly Error: {str(e)}"}), 200
    
@app.route('/api/alerts/active')
def get_active_alerts():
    conn = get_db_conn()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cursor:
            # 1. DB에서 현재 설정된 알람 최소 횟수를 가져옴
            cursor.execute("SELECT setting_value FROM alert_settings WHERE setting_key = 'ALERT_MIN_COUNT'")
            row = cursor.fetchone()
            min_count = int(row['setting_value']) if row else 3 # 없을 경우 기본 3회

            today_str = datetime.now().strftime('%Y-%m-%d') # 💡 파이썬 시간 기준 오늘 날짜
            cursor.execute("""
                SELECT a.worker_id, COUNT(*) as count, MAX(a.created_at) as last_time,
                       w.line_id, w.process_id
                FROM factory_alerts a
                LEFT JOIN worker_master w ON a.worker_id = w.worker_id
                WHERE a.is_resolved = 0 AND a.created_at LIKE %s
                GROUP BY a.worker_id, w.line_id, w.process_id
                HAVING count >= %s
            """, (f"{today_str}%", min_count))
            
            alerts = cursor.fetchall()
            for a in alerts:
                a['last_time'] = str(a['last_time']) if a['last_time'] else "-"
            return jsonify({"status": "success", "alerts": alerts})
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"status": "error", "message": f"Alerts Error: {str(e)}"}), 200

@app.route('/api/recommend')
def get_recommendation():
    engine = None
    try:
        engine = RecommendationEngine()
        plan = engine.generate_optimal_placement()
        
        if plan is None or plan.empty:
            return jsonify({"status": "error", "message": "작업자 데이터가 없습니다."})
        
        conn = get_db_conn()
        smv_map = {}
        with conn.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute("SELECT process_id, base_smv FROM process_master")
            for row in cursor.fetchall():
                smv_map[row['process_id']] = row['base_smv']
        
        initial_mapping = plan[['worker_id', 'current_line', 'current_process', 'ai_line', 'ai_process', 'cont_line', 'cont_process', 'current_efficiency', 'learning_rate']].to_dict(orient='records')
        return jsonify({"status": "success", "smv_map": smv_map, "initial_mapping": initial_mapping})
        
    except Exception as e:
        error_log = traceback.format_exc()
        print(error_log) 
        return jsonify({"status": "error", "message": f"AI 분석 로직 에러: {str(e)}"}), 200
    finally:
        if engine:
            engine.close()

@app.route('/api/apply', methods=['POST', 'OPTIONS'])
@token_required
def apply_recommendation():
    if request.user_role != 'admin':
        return jsonify({"status": "error", "message": "관리자 권한이 필요합니다."}), 403
    updates = request.json.get('updates', [])
    conn = get_db_conn()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cursor:
            # 히스토리 백업
            cursor.execute("SELECT worker_id, line_id, process_id FROM worker_master")
            current_state = cursor.fetchall()
            cursor.execute("INSERT INTO placement_history (placement_data, description) VALUES (%s, %s)", (json.dumps(current_state), f"Update at {datetime.now()}"))
            
            # 💡 [핵심 수정 1] 새로운 배치를 꽂기 전에, 기존 모든 작업자와 공정의 매핑을 NULL로 완벽히 청소
            cursor.execute("UPDATE worker_master SET line_id = NULL, process_id = NULL")
            cursor.execute("UPDATE line_process_map SET worker_id = NULL")
            
            # 💡 [핵심 수정 2] 프론트에서 올라온 진짜 100명만 마스터와 구조도에 동시 업데이트
            for row in updates:
                cursor.execute("UPDATE worker_master SET line_id = %s, process_id = %s WHERE worker_id = %s", 
                              (row['new_line_id'], row['new_process_id'], row['worker_id']))
                cursor.execute("UPDATE line_process_map SET worker_id = %s WHERE line_id = %s AND process_id = %s",
                              (row['worker_id'], row['new_line_id'], row['new_process_id']))
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 200

@app.route('/api/rollback', methods=['POST', 'OPTIONS'])
def rollback_recommendation():
    conn = get_db_conn()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute("SELECT history_id, placement_data FROM placement_history ORDER BY history_id DESC LIMIT 1")
            history = cursor.fetchone()
            if not history: return jsonify({"status": "error", "message": "복구 이력 없음"})
            
            # 💡 롤백 시에도 전체 초기화 먼저 진행해서 유령 작업자 원천 차단
            cursor.execute("UPDATE worker_master SET line_id = NULL, process_id = NULL")
            cursor.execute("UPDATE line_process_map SET worker_id = NULL")
            
            for row in json.loads(history['placement_data']):
                cursor.execute("UPDATE worker_master SET line_id = %s, process_id = %s WHERE worker_id = %s", (row['line_id'], row['process_id'], row['worker_id']))
                if row['line_id'] and row['process_id']:
                    cursor.execute("UPDATE line_process_map SET worker_id = %s WHERE line_id = %s AND process_id = %s", (row['worker_id'], row['line_id'], row['process_id']))
                    
            cursor.execute("DELETE FROM placement_history WHERE history_id = %s", (history['history_id'],))
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/worker/<worker_id>/metrics')
def get_worker_metrics(worker_id):
    conn = get_db_conn()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute("SELECT target_date, avg_efficiency, total_production_qty, total_alerts_count, daily_grade FROM worker_performance_metrics WHERE worker_id = %s ORDER BY target_date ASC LIMIT 7", (worker_id,))
            metrics = cursor.fetchall()
            for m in metrics:
                if hasattr(m['target_date'], 'strftime'): m['target_date'] = m['target_date'].strftime('%Y-%m-%d')
            return jsonify({"status": "success", "data": metrics})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/alert/reset', methods=['POST', 'OPTIONS'])
def reset_worker_alert():
    conn = get_db_conn()
    try:
        with conn.cursor() as cursor:
            cursor.execute("UPDATE factory_alerts SET is_resolved = 1 WHERE worker_id = %s AND is_resolved = 0 AND DATE(created_at) = CURDATE()", (request.json.get('worker_id'),))
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/alert/reset_all', methods=['POST', 'OPTIONS'])
@token_required
def reset_all_alerts():
    if request.user_role != 'admin':
        return jsonify({"status": "error", "message": "권한이 없습니다."}), 403
        
    conn = get_db_conn()
    try:
        with conn.cursor() as cursor:
            # 오늘 날짜의 모든 미결 알람을 조치 완료 처리
            cursor.execute("""
                UPDATE factory_alerts 
                SET is_resolved = 1 
                WHERE is_resolved = 0 AND DATE(created_at) = CURDATE()
            """)
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 500
    
@app.route('/api/analytics/fatigue')
def get_fatigue_analytics():
    conn = get_db_conn()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute("SELECT w.worker_id as id, w.line_id as line, w.process_id as process, w.current_efficiency as base_eff, p.base_smv as smv, COALESCE(m.stamina_factor, 1.0) as stamina FROM worker_master w JOIN process_master p ON w.process_id = p.process_id LEFT JOIN worker_fatigue_mart m ON w.worker_id = m.worker_id")
            return jsonify({"status": "success", "data": cursor.fetchall()})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/admin/topology', methods=['GET', 'OPTIONS'])
@token_required
def get_topology():
    conn = get_db_conn()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute("""
                SELECT line_id, process_id, worker_id, step_sequence 
                FROM line_process_map 
                WHERE worker_id IS NOT NULL 
                ORDER BY line_id, step_sequence
            """)
            mapping = cursor.fetchall()
            
            layout = {}
            for m in mapping:
                l_id = m['line_id']
                if l_id not in layout: layout[l_id] = []
                layout[l_id].append({'proc': m['process_id'], 'seq': m['step_sequence'], 'worker': m['worker_id']})
            
            cursor.execute("SELECT process_id as id, base_smv as smv FROM process_master")
            processes = cursor.fetchall()
            
            cursor.execute("SELECT worker_id, current_efficiency FROM worker_master WHERE line_id IS NULL OR line_id = '' OR process_id IS NULL OR process_id = ''")
            idle_workers = cursor.fetchall()
            
            return jsonify({"status": "success", "layout": layout, "processes": processes, "idle_workers": idle_workers})
    except Exception as e:
        return jsonify({"status": "error", "message": f"DB 쿼리 실패: {str(e)}"}), 200 

@app.route('/api/admin/topology/update', methods=['POST', 'OPTIONS'])
@token_required
def update_admin_topology():
    if request.user_role != 'admin': return jsonify({"status": "error"}), 403
    layout = request.json.get('layout', {})
    conn = get_db_conn()
    try:
        with conn.cursor() as cursor:
            cursor.execute("UPDATE worker_master SET line_id = NULL, process_id = NULL WHERE line_id IS NOT NULL")
            for line_id, nodes in layout.items():
                for node in nodes:
                    w_id = node.get('worker')
                    if not w_id: continue
                    cursor.execute("UPDATE line_process_map SET worker_id = %s WHERE line_id = %s AND process_id = %s AND step_sequence = %s", 
                                   (w_id, line_id, node.get('proc'), node.get('seq')))
                    cursor.execute("UPDATE worker_master SET line_id = %s, process_id = %s WHERE worker_id = %s", 
                                   (line_id, node.get('proc'), w_id))
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 200

@app.route('/api/admin/process', methods=['POST', 'OPTIONS'])
@token_required
def add_admin_process():
    data = request.json
    conn = get_db_conn()
    try:
        with conn.cursor() as cursor:
            # 중복 검사
            cursor.execute("SELECT process_id FROM process_master WHERE process_id = %s", (data['process_id'],))
            if cursor.fetchone():
                return jsonify({"status": "error", "message": "이미 존재하는 공정 코드입니다."}), 200
                
            cursor.execute("INSERT INTO process_master (process_id, base_smv) VALUES (%s, %s)", (data['process_id'], data['smv']))
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 200
        
@app.route('/api/admin/line', methods=['POST', 'OPTIONS'])
@token_required
def add_admin_line():
    data = request.json
    line_id = data['line_id']
    is_edit = data.get('is_edit', False)
    conn = get_db_conn()
    try:
        with conn.cursor() as cursor:
            # 수정 모드가 아닐 때만 중복 검사
            if not is_edit:
                cursor.execute("SELECT DISTINCT line_id FROM line_process_map WHERE line_id = %s", (line_id,))
                if cursor.fetchone():
                    return jsonify({"status": "error", "message": f"[{line_id}] 라인은 이미 존재합니다."}), 200
            else:
                # 수정 모드: 기존 라인의 매핑을 해체하고 작업자들을 대기열로 복귀시킴
                cursor.execute("UPDATE worker_master SET line_id = NULL, process_id = NULL WHERE line_id = %s", (line_id,))
                cursor.execute("DELETE FROM line_process_map WHERE line_id = %s", (line_id,))

            # 새로운 시퀀스로 재조립
            for idx, item in enumerate(data['sequence']):
                proc_id = item['proc']
                w_id = item['worker']
                cursor.execute("INSERT INTO line_process_map (line_id, process_id, step_sequence, worker_id) VALUES (%s, %s, %s, %s)", 
                               (line_id, proc_id, idx+1, w_id))
                cursor.execute("UPDATE worker_master SET line_id = %s, process_id = %s WHERE worker_id = %s", 
                               (line_id, proc_id, w_id))
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 200

@app.route('/api/admin/process/delete', methods=['POST', 'OPTIONS'])
@token_required
def delete_admin_process():
    data = request.json
    proc_id = data['process_id']
    conn = get_db_conn()
    try:
        with conn.cursor() as cursor:
            # 방어 로직: 어느 라인에서든 사용 중인 공정이면 삭제 거부
            cursor.execute("SELECT map_id FROM line_process_map WHERE process_id = %s LIMIT 1", (proc_id,))
            if cursor.fetchone():
                return jsonify({"status": "error", "message": "해당 공정은 현재 라인에 배치되어 있어 삭제할 수 없습니다. 먼저 모든 라인에서 해당 공정을 빼주세요."}), 200
            
            cursor.execute("DELETE FROM process_master WHERE process_id = %s", (proc_id,))
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 200

@app.route('/api/admin/line/delete', methods=['POST', 'OPTIONS'])
@token_required
def delete_admin_line():
    if request.user_role != 'admin': return jsonify({"status": "error"}), 403
    line_id = request.json.get('line_id')
    conn = get_db_conn()
    try:
        with conn.cursor() as cursor:
            cursor.execute("UPDATE worker_master SET line_id = NULL, process_id = NULL WHERE line_id = %s", (line_id,))
            cursor.execute("DELETE FROM line_process_map WHERE line_id = %s", (line_id,))
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 200

# 💡 [교체] 작업자 인력 관리 (중복 방어 및 랜덤 학습률 적용)
@app.route('/api/admin/worker/<action>', methods=['POST', 'OPTIONS'])
@token_required
def manage_worker(action):
    data = request.json
    w_id = data.get('worker_id')
    conn = get_db_conn()
    try:
        with conn.cursor() as cursor:
            if action == 'add':
                # 중복 검사
                cursor.execute("SELECT worker_id FROM worker_master WHERE worker_id = %s", (w_id,))
                if cursor.fetchone():
                    return jsonify({"status": "error", "message": "이미 등록된 작업자 ID입니다."}), 200
                
                # 💡 [핵심] 0.05 하드코딩 제거하고 0.8 ~ 1.2 사이의 랜덤 학습률(소수점 둘째 자리) 부여
                import random
                new_lr = round(random.uniform(0.8, 1.2), 2)
                
                cursor.execute("INSERT INTO worker_master (worker_id, current_efficiency, learning_rate, line_id, process_id) VALUES (%s, %s, %s, NULL, NULL)", (w_id, data.get('efficiency'), new_lr))
                
            elif action == 'retire':
                cursor.execute("UPDATE worker_master SET line_id = NULL, process_id = NULL WHERE worker_id = %s", (w_id,))
                cursor.execute("DELETE FROM line_process_map WHERE worker_id = %s", (w_id,))
            elif action == 'delete':
                cursor.execute("DELETE FROM line_process_map WHERE worker_id = %s", (w_id,))
                cursor.execute("DELETE FROM worker_master WHERE worker_id = %s", (w_id,))
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 200

@app.route('/api/admin/users', methods=['GET', 'POST', 'OPTIONS'])
@token_required
def manage_users():
    if request.user_role != 'admin':
        return jsonify({"status": "error", "message": "권한 부족"}), 403
    conn = get_db_conn()
    try:
        if request.method == 'GET':
            with conn.cursor(pymysql.cursors.DictCursor) as cursor:
                cursor.execute("SELECT username, password_hash as password, role FROM system_users")
                users = cursor.fetchall()
                return jsonify({"status": "success", "data": users})
                
        elif request.method == 'POST':
            data = request.json
            hashed_pw = hashlib.sha256(data.get('password').encode()).hexdigest()
            with conn.cursor() as cursor:
                cursor.execute("INSERT INTO system_users (username, password_hash, role) VALUES (%s, %s, %s)", 
                               (data.get('username'), hashed_pw, data.get('role', 'user')))
            conn.commit()
            return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 200

@app.route('/api/admin/users/<username>', methods=['DELETE', 'OPTIONS'])
@token_required
def delete_user(username):
    if request.user_role != 'admin':
        return jsonify({"status": "error", "message": "권한 부족"}), 403
    conn = get_db_conn()
    try:
        with conn.cursor() as cursor:
            cursor.execute("DELETE FROM system_users WHERE username = %s", (username,))
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 200

def lambda_handler(event, context):
    http_method = event.get('httpMethod') or event.get('requestContext', {}).get('http', {}).get('method', '')
    if http_method == 'OPTIONS':
        return {
            "statusCode": 200,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization"
            },
            "body": "OK"
        }
    return awsgi.response(app, event, context)

@app.route('/api/admin/alerts/settings', methods=['GET', 'POST', 'OPTIONS'])
@token_required
def manage_alert_settings():
    if request.user_role != 'admin':
        return jsonify({"status": "error", "message": "권한이 없습니다."}), 403
    
    conn = get_db_conn()
    try:
        if request.method == 'GET':
            with conn.cursor(pymysql.cursors.DictCursor) as cursor:
                cursor.execute("SELECT setting_key, setting_value, description FROM alert_settings")
                return jsonify({"status": "success", "data": cursor.fetchall()})
                
        elif request.method == 'POST':
            updates = request.json.get('updates', [])
            with conn.cursor() as cursor:
                for item in updates:
                    cursor.execute("UPDATE alert_settings SET setting_value = %s WHERE setting_key = %s", 
                                   (float(item['val']), item['key']))
            conn.commit()
            return jsonify({"status": "success"})
            
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 200

# ==========================================
# 1. DLQ
# ==========================================
@app.route('/api/dlq/messages', methods=['GET', 'OPTIONS'])
@token_required
def get_dlq_messages():
    if request.user_role != 'admin':
        return jsonify({"status": "error", "message": "권한이 없습니다."}), 403
        
    try:
        # SQS에서 최대 10개의 메시지 가져오기
        response = sqs_client.receive_message(
            QueueUrl=SQS_QUEUE_URL,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=2
        )
        
        messages = response.get('Messages', [])
        return jsonify({"status": "success", "messages": messages})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/dlq/replay_all', methods=['POST', 'OPTIONS'])
@token_required
def replay_all_dlq():
    if request.user_role != 'admin':
        return jsonify({"status": "error", "message": "권한이 없습니다."}), 403
        
    success_count = 0
    max_loops = 50 # 최대 500건 (10건 * 50번)까지만 1회 호출 시 처리하여 람다 타임아웃 방지
    
    try:
        for _ in range(max_loops):
            # SQS에서 10건씩 긁어오기
            response = sqs_client.receive_message(
                QueueUrl=SQS_QUEUE_URL,
                MaxNumberOfMessages=10,
                WaitTimeSeconds=1
            )
            messages = response.get('Messages', [])
            
            # 더 이상 긁어올 메시지가 없으면 루프 종료
            if not messages:
                break
                
            for msg in messages:
                # Kinesis로 쏴주기
                kinesis_client.put_record(
                    StreamName=KINESIS_STREAM_NAME,
                    Data=msg['Body'].encode('utf-8'),
                    PartitionKey='replay_partition'
                )
                # SQS에서 삭제
                sqs_client.delete_message(
                    QueueUrl=SQS_QUEUE_URL,
                    ReceiptHandle=msg['ReceiptHandle']
                )
                success_count += 1
                
        return jsonify({"status": "success", "replayed_count": success_count})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    
# ==========================================
# 2. Athena Ad-hoc 쿼리 API
# ==========================================
@app.route('/api/athena/query', methods=['POST', 'OPTIONS'])
@token_required
def run_athena_query():
    query = request.json.get('query')
    try:
        # 쿼리 실행
        exec_response = athena_client.start_query_execution(
            QueryString=query,
            QueryExecutionContext={'Database': 'factory_data_lake_db'},
            WorkGroup='factory_analytics_workgroup'
        )
        exec_id = exec_response['QueryExecutionId']
        
        # 데모용: 프론트에서 폴링하기 번거로우니 람다에서 살짝 대기 후 결과 반환 (최대 5초)
        for _ in range(10):
            status = athena_client.get_query_execution(QueryExecutionId=exec_id)
            state = status['QueryExecution']['Status']['State']
            if state == 'SUCCEEDED':
                res = athena_client.get_query_results(QueryExecutionId=exec_id, MaxResults=100)
                # 데이터 파싱 (헤더와 로우 분리)
                rows = [[d.get('VarCharValue', '') for d in r['Data']] for r in res['ResultSet']['Rows']]
                return jsonify({"status": "success", "columns": rows[0], "rows": rows[1:]})
            elif state in ['FAILED', 'CANCELLED']:
                reason = status['QueryExecution']['Status'].get('StateChangeReason', 'Unknown')
                return jsonify({"status": "error", "message": f"Query {state}: {reason}"})
            time.sleep(0.5)
            
        return jsonify({"status": "error", "message": "쿼리 실행 시간이 너무 깁니다. (Timeout)"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

# ==========================================
# 4. AWS Cost Explorer API
# ==========================================
@app.route('/api/cost/today', methods=['GET', 'OPTIONS'])
@token_required
def get_today_cost():
    try:
        now = datetime.utcnow()
        start = (now - timedelta(days=1)).strftime('%Y-%m-%d')
        end = now.strftime('%Y-%m-%d')
        
        response = ce_client.get_cost_and_usage(
            TimePeriod={'Start': start, 'End': end},
            Granularity='DAILY',
            Metrics=['UnblendedCost']
        )
        cost = response['ResultsByTime'][0]['Total']['UnblendedCost']['Amount']
        return jsonify({"status": "success", "cost": round(float(cost), 2)})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    
@app.route('/api/cost/live_base', methods=['GET', 'OPTIONS'])
@token_required
def get_cost_live_base():
    if request.user_role != 'admin':
        return jsonify({"status": "error", "message": "권한이 없습니다."}), 403

    # KST 기준 오늘 자정(00:00:00) 시간 구하기
    kst = pytz.timezone('Asia/Seoul')
    now_kst = datetime.now(kst)
    start_of_today = now_kst.replace(hour=0, minute=0, second=0, microsecond=0)
    
    cw = boto3.client('cloudwatch', region_name='ap-northeast-2')
    
    def get_daily_sum(namespace, metric, dimensions):
        res = cw.get_metric_statistics(
            Namespace=namespace,
            MetricName=metric,
            Dimensions=dimensions,
            StartTime=start_of_today,
            EndTime=now_kst,
            Period=86400, # 24시간을 하나의 데이터 포인트로
            Statistics=['Sum']
        )
        return res['Datapoints'][0]['Sum'] if res['Datapoints'] else 0

    try:
        # 1. Kinesis 누적 (PutRecords.SuccessfulRecords)
        kinesis_sum = get_daily_sum('AWS/Kinesis', 'PutRecords.SuccessfulRecords', [{'Name': 'StreamName', 'Value': 'factory_logs'}])
        
        # 2. Lambda 누적 (모든 주요 람다 합산)
        lambda_detector = get_daily_sum('AWS/Lambda', 'Invocations', [{'Name': 'FunctionName', 'Value': 'realtime_detector'}])
        lambda_aggregator = get_daily_sum('AWS/Lambda', 'Invocations', [{'Name': 'FunctionName', 'Value': 'hourly_aggregator'}])
        lambda_firehose = get_daily_sum('AWS/Lambda', 'Invocations', [{'Name': 'FunctionName', 'Value': 'firehose_transformer'}])
        lambda_total = lambda_detector + lambda_aggregator + lambda_firehose
        
        # 3. S3 누적 (Firehose를 통한 S3 Put - CloudWatch의 PutRequests 지표 활용)
        # 주의: 아래 버킷 이름은 실제 사용 중인 이름으로 변경해야 함
        s3_put = get_daily_sum('AWS/S3', 'PutRequests', [{'Name': 'BucketName', 'Value': 'scada-factory-raw-data-bucket-fvmk99'}, {'Name': 'FilterId', 'Value': 'EntireBucket'}])
        
        # 4. RDS 시간 누적
        hours_passed = now_kst.hour + (now_kst.minute / 60)

        return jsonify({
            "status": "success",
            "kinesis_records": kinesis_sum,
            "lambda_invocations": lambda_total,
            "s3_requests": s3_put,
            "hours_passed": hours_passed
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500