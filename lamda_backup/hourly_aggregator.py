import awswrangler as wr
import pandas as pd
from init_db import get_db_conn

def lambda_handler(event, context):
    conn = get_db_conn()

    for record in event['Records']:
        bucket = record['s3']['bucket']['name']
        key = record['s3']['object']['key']
        s3_path = f"s3://{bucket}/{key}"
        
        # 1. Parquet 파일 고속 로드
        df = wr.s3.read_parquet(path=[s3_path])
        
        if df.empty: continue
        
        # 2. END 상태 로그만 필터링 (불필요한 작업 제거)
        if 'status' in df.columns:
            df = df[df['status'] == 'END']
        
        if df.empty: continue
        
        # 3. 시간 집계 파생 변수 생성
        df['timestamp'] = pd.to_datetime(df['timestamp'])
        df['target_hour'] = df['timestamp'].dt.strftime("%Y-%m-%d %H")
        df['event_ts_str'] = df['timestamp'].dt.strftime("%Y-%m-%d %H:%M:%S")
        
        # 4. Pandas를 이용한 고속 그룹바이(Group By) 연산
        # 기존의 복잡했던 defaultdict 반복문이 한 줄로 정리됨
        agg_df = df.groupby(['target_hour', 'worker_id', 'line_id', 'process_id']).agg(
            total_duration=('duration', 'sum'),
            total_qty=('worker_id', 'count'), 
            max_ts=('event_ts_str', 'max')
        ).reset_index()
        
        window_start_str = df['timestamp'].min().strftime("%Y-%m-%d %H:%M:%S")
        window_end_str = df['timestamp'].max().strftime("%Y-%m-%d %H:%M:%S")

        # 5. DB 적재
        with conn.cursor() as cursor:
            # 💡 1. N+1 문제 해결: 5분 윈도우 전체 알람 내역을 한 번의 쿼리로 가져옴
            alert_query = """
                SELECT worker_id, COUNT(*) as a_count 
                FROM factory_alerts 
                WHERE created_at BETWEEN %s AND %s 
                GROUP BY worker_id
            """
            cursor.execute(alert_query, (window_start_str, window_end_str))
            
            # DB 종류 및 커서 설정에 따라 결과값이 튜플일 수도, 딕셔너리일 수도 있으므로 방어적 변환
            # (일반 cursor의 경우 튜플 반환: row[0]=worker_id, row[1]=a_count)
            alert_rows = cursor.fetchall()
            alert_dict = {
                (row['worker_id'] if isinstance(row, dict) else row[0]): 
                (row['a_count'] if isinstance(row, dict) else row[1]) 
                for row in alert_rows
            } if alert_rows else {}

            # 💡 2. 파이썬 메모리 상에서 매핑
            insert_rows = []
            for _, row in agg_df.iterrows():
                w_id = row['worker_id']
                
                # 쿼리를 날리는 대신 딕셔너리에서 즉시 획득 (없으면 0)
                a_count = alert_dict.get(w_id, 0)
                
                insert_rows.append((
                    row['line_id'], row['process_id'], w_id, row['target_hour'], 
                    float(row['total_duration']), int(row['total_qty']), 
                    a_count, row['max_ts']
                ))
        
            if insert_rows:
                sql = """
                    INSERT INTO hourly_stats (line_id, process_id, worker_id, target_hour, total_duration, total_qty, anomaly_count, last_event_time) 
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE 
                        total_duration = total_duration + VALUES(total_duration),
                        total_qty = total_qty + VALUES(total_qty),
                        anomaly_count = anomaly_count + VALUES(anomaly_count),
                        avg_duration = total_duration / total_qty,
                        last_event_time = GREATEST(last_event_time, VALUES(last_event_time))
                """
                cursor.executemany(sql, insert_rows)
            from datetime import datetime, timedelta
            now_kst = datetime.utcnow() + timedelta(hours=9)
            current_hour_str = now_kst.strftime('%Y-%m-%d %H:00:00')
            
            # 현재 정각(예: 11:00:00)보다 과거인 데이터는 실시간 테이블에서 완전 삭제
            cursor.execute("DELETE FROM realtime_line_status WHERE target_hour < %s", (current_hour_str,))
            
            conn.commit()
        
    return {"statusCode": 200}