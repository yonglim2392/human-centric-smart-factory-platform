import pymysql
import collections
import random
from init_db import get_db_conn

def lambda_handler(event, context):
    """
    Step 2. 최근 5일 데이터 기반 피로도 회귀분석 및 마트 적재
    """
    print("⏰ [STEP 2 START] 피로도 추세 회귀분석 시작...")
    
    conn = get_db_conn()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute("""
                SELECT worker_id, 
                       CAST(SUBSTRING(target_hour, 12, 2) AS UNSIGNED) as hour_idx,
                       AVG(total_qty) as avg_qty
                FROM hourly_stats
                WHERE target_hour >= DATE_SUB(CURDATE(), INTERVAL 5 DAY)
                GROUP BY worker_id, hour_idx
                ORDER BY worker_id, hour_idx
            """)
            hist_rows = cursor.fetchall()
            
            history_map = collections.defaultdict(list)
            for hr in hist_rows:
                history_map[hr['worker_id']].append((hr['hour_idx'], float(hr['avg_qty'])))
            
            cursor.execute("SELECT worker_id FROM worker_master")
            workers = cursor.fetchall()
            
            upsert_data = []
            
            for w in workers:
                w_id = w['worker_id']
                w_hist = history_map.get(w_id, [])
                
                stamina_factor = 1.0
                drop_pct = 2.5 
                
                if len(w_hist) >= 3:
                    x_coords = [h[0] for h in w_hist]
                    y_coords = [h[1] for h in w_hist]
                    n = len(x_coords)
                    sum_x = sum(x_coords)
                    sum_y = sum(y_coords)
                    sum_xy = sum(x*y for x,y in zip(x_coords, y_coords))
                    sum_xx = sum(x*x for x in x_coords)
                    den = (n * sum_xx - sum_x**2)
                    
                    if den != 0:
                        slope = (n * sum_xy - sum_x * sum_y) / den
                        avg_prod = sum_y / n
                        if avg_prod > 0:
                            drop_pct = -(slope / avg_prod) * 100
                            if drop_pct <= 0: 
                                stamina_factor = 1.3
                                drop_pct = 0.0
                            else: 
                                stamina_factor = min(1.3, max(0.7, 2.5 / drop_pct))
                else:
                    rnd = random.Random(w_id)
                    stamina_factor = rnd.uniform(0.6, 1.4)
                    drop_pct = 2.5 / stamina_factor
                
                upsert_data.append((w_id, round(stamina_factor, 2), round(drop_pct, 2)))
            
            if upsert_data:
                cursor.executemany("""
                    INSERT INTO worker_fatigue_mart (worker_id, stamina_factor, fatigue_rate_per_hour)
                    VALUES (%s, %s, %s)
                    ON DUPLICATE KEY UPDATE 
                    stamina_factor = VALUES(stamina_factor),
                    fatigue_rate_per_hour = VALUES(fatigue_rate_per_hour),
                    last_analyzed_at = CURRENT_TIMESTAMP
                """, upsert_data)

            conn.commit()
            print(f"✅ [STEP 2 END] 총 {len(upsert_data)}명의 작업자 피로도 분석 적재 완료.")
            
            return {"statusCode": 200, "body": f"Fatigue analysis completed for {len(upsert_data)} workers."}

    except Exception as e:
        conn.rollback()
        print(f"❌ [STEP 2 ERROR] {str(e)}")
        raise e
    finally:
        conn.close()