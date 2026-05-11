import pymysql
from datetime import datetime
from init_db import get_db_conn

def lambda_handler(event, context):
    """
    Step 1. 일일 생산량 정산 및 숙련도(Learning Rate) 업데이트
    """
    print("⏰ [STEP 1 START] 일일 정산 처리 시작...")
    
    conn = get_db_conn()
    try:
        today_str = datetime.now().strftime('%Y-%m-%d')
        
        with conn.cursor(pymysql.cursors.DictCursor) as cursor:
            query1 = """
                SELECT 
                    s.worker_id, 
                    p.base_smv as difficulty, 
                    m.current_efficiency as old_efficiency,
                    m.learning_rate, 
                    AVG(s.avg_duration) as actual_avg_time,
                    SUM(s.total_qty) as total_qty,
                    SUM(s.anomaly_count) as alert_count
                FROM hourly_stats s
                JOIN worker_master m ON s.worker_id = m.worker_id
                JOIN process_master p ON m.process_id = p.process_id
                WHERE s.target_hour LIKE %s
                GROUP BY s.worker_id, p.base_smv, m.current_efficiency, m.learning_rate
            """
            cursor.execute(query1, (f"{today_str}%",))
            rows1 = cursor.fetchall()
            
            processed_count = 0
            if rows1:
                for row in rows1:
                    alert_count = int(row['alert_count'] or 0)
                    actual_avg_time = float(row['actual_avg_time'] or 0)
                    difficulty = float(row['difficulty'] or 0)
                    old_eff = float(row['old_efficiency'] or 0)
                    lr = float(row['learning_rate'] or 1.0)
                    total_qty = int(row['total_qty'] or 0)
                    
                    if actual_avg_time == 0: continue
                    
                    penalty = alert_count * 0.5
                    today_efficiency = (difficulty / (actual_avg_time + penalty)) * 100
                    
                    if today_efficiency >= 110: grade = 'S'
                    elif today_efficiency >= 100: grade = 'A'
                    elif today_efficiency >= 90: grade = 'B'
                    elif today_efficiency >= 80: grade = 'C'
                    else: grade = 'D'

                    gap = today_efficiency - old_eff  
                    base_ratio = 0.3 
                    apply_ratio = (base_ratio * lr) if gap > 0 else (base_ratio / lr)
                    apply_ratio = max(0.1, min(0.5, apply_ratio))
                    new_efficiency = round(old_eff + (gap * apply_ratio), 2)

                    # 중복 실행 방지를 위한 UPSERT 적용
                    cursor.execute("""
                        INSERT INTO worker_performance_metrics 
                        (worker_id, target_date, avg_efficiency, daily_grade, total_production_qty, total_alerts_count)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        ON DUPLICATE KEY UPDATE
                        avg_efficiency = VALUES(avg_efficiency),
                        daily_grade = VALUES(daily_grade),
                        total_production_qty = VALUES(total_production_qty),
                        total_alerts_count = VALUES(total_alerts_count)
                    """, (row['worker_id'], today_str, round(today_efficiency, 2), grade, total_qty, alert_count))

                    cursor.execute("""
                        INSERT INTO worker_efficiency_history 
                        (worker_id, recorded_date, efficiency_val)
                        VALUES (%s, %s, %s)
                        ON DUPLICATE KEY UPDATE
                        efficiency_val = VALUES(efficiency_val)
                    """, (row['worker_id'], today_str, round(today_efficiency, 2)))

                    cursor.execute("""
                        UPDATE worker_master 
                        SET current_efficiency = %s, last_updated = NOW() 
                        WHERE worker_id = %s
                    """, (new_efficiency, row['worker_id']))
                    
                    processed_count += 1

            conn.commit()
            print(f"✅ [STEP 1 END] 총 {processed_count}명의 작업자 일일 정산 완료.")
            
            return {"statusCode": 200, "body": f"Settlement completed for {processed_count} workers."}

    except Exception as e:
        conn.rollback()
        print(f"❌ [STEP 1 ERROR] {str(e)}")
        raise e  # Step Functions에서 에러를 감지하고 재시도할 수 있도록 에러 발생
    finally:
        conn.close()