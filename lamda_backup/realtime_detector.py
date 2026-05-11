import json
import base64
from datetime import datetime
import pymysql
from init_db import get_db_conn

# 💡 메모리 캐싱을 위한 글로벌 변수 선언
_cached_duration_map = None

def load_target_duration_map(conn):
    """작업자 마스터와 공정 마스터를 조인해서 개인별 목표 소요 시간을 계산"""
    with conn.cursor(pymysql.cursors.DictCursor) as cursor:
        cursor.execute("SET time_zone = '+09:00'")
        sql = """
            SELECT w.worker_id, w.current_efficiency, p.base_smv
            FROM worker_master w
            JOIN process_master p ON w.process_id = p.process_id
        """
        cursor.execute(sql)
        rows = cursor.fetchall()
        
        duration_dict = {}
        for row in rows:
            w_id = row['worker_id'].strip()
            eff = row['current_efficiency']
            smv = row['base_smv']
            duration_dict[w_id] = smv / (eff / 100)
        return duration_dict

def save_alert(cursor, worker_id, a_type, val, limit, event_ts_str):
    """DB에 알람 내역 저장"""
    sql = "INSERT INTO factory_alerts (worker_id, alert_type, alert_value, threshold, created_at) VALUES (%s, %s, %s, %s, %s)"
    cursor.execute(sql, (worker_id, a_type, val, limit, event_ts_str))
    print(f"⚠️  [ALERT] {worker_id} - {a_type} 발생! (측정: {val:.1f} / 기준: {limit:.1f})")

def load_alert_settings(conn):
    with conn.cursor(pymysql.cursors.DictCursor) as cursor:
        cursor.execute("SELECT setting_key, setting_value FROM alert_settings")
        rows = cursor.fetchall()
        return {row['setting_key']: float(row['setting_value']) for row in rows}
    
def lambda_handler(event, context):
    global _cached_duration_map
    conn = get_db_conn()
    
    # 💡 람다가 처음 실행될 때(캐시가 비어있을 때)만 DB에서 조회!
    if _cached_duration_map is None:
        _cached_duration_map = load_target_duration_map(conn)
        print("마스터 데이터 캐싱 완료")
    
    # 매 호출(배치)마다 최신 설정값을 DB에서 가져옴 (거의 실시간 반영)
    alert_settings = load_alert_settings(conn)
    delay_mult = alert_settings.get('DELAY_MULTIPLIER', 2.0)
    overload_amp = alert_settings.get('OVERLOAD_AMP', 5.0)
    idle_amp = alert_settings.get('IDLE_AMP', 1.0)

    with conn.cursor() as cursor:
        cursor.execute("SET time_zone = '+09:00'")
        
        # Kinesis 배치 데이터 순회
        for record in event['Records']:
            payload = base64.b64decode(record['kinesis']['data']).decode('utf-8')
            data = json.loads(payload)
            
            if data.get('status') == 'END':
                worker_id = data['worker_id'].strip()
                amp = data.get('current_amp', 0)
                
                # Payload에서 라인/공정 정보 추출
                line_id = data.get('line_id', '')
                process_id = data.get('process_id', '')

                start_ts = datetime.fromisoformat(data['start_time'])
                end_ts = datetime.fromisoformat(data['timestamp'])
                actual_duration = (end_ts - start_ts).total_seconds()
                
                # 💡 [핵심] 실시간 생산량(Hot Data) +1 카운트 업데이트
                if line_id and process_id:
                    target_hour = end_ts.strftime('%Y-%m-%d %H:00:00')
                    upsert_sql = """
                        INSERT INTO realtime_line_status (line_id, process_id, target_hour, qty)
                        VALUES (%s, %s, %s, 1)
                        ON DUPLICATE KEY UPDATE qty = qty + 1
                    """
                    cursor.execute(upsert_sql, (line_id, process_id, target_hour))
                    
                # 💡 매번 함수를 부르지 않고, 메모리(_cached_duration_map)에서 초고속으로 꺼내 씀
                target_duration = _cached_duration_map.get(worker_id)
                if target_duration is None:
                    target_duration = 30.0
                
                event_ts_str = end_ts.strftime('%Y-%m-%d %H:%M:%S')

                # 1. 작업 지연 체크
                if actual_duration > (target_duration * delay_mult):
                    save_alert(cursor, worker_id, 'PROCESS_DELAY', actual_duration, target_duration * delay_mult, event_ts_str)
                    
                # 2. 전류 과부하 체크
                if amp > overload_amp:
                    save_alert(cursor, worker_id, 'OVERLOAD', amp, overload_amp, event_ts_str)
                    
                # 3. 공회전 체크
                elif amp < idle_amp:
                    save_alert(cursor, worker_id, 'IDLE_RUN', amp, idle_amp, event_ts_str)
                    
        conn.commit()

    return {"statusCode": 200}