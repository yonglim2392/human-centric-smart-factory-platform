import awswrangler as wr
import pandas as pd
import pymysql
import os
from init_db import get_db_conn
from datetime import datetime, timedelta

def lambda_handler(event, context):
    print("⏰ [ARCHIVE START] 7일 경과 데이터 S3 아카이빙 시작...")
    
    conn = get_db_conn()
    archive_bucket = os.environ.get('ARCHIVE_BUCKET_PATH', 's3://your-raw-data-bucket/archive/hourly_stats/')
    
    try:
        # 기준일: 현재로부터 7일 전
        target_date = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d 00:00:00')
        
        # 1. 아카이빙 대상 데이터 조회 (Pandas DataFrame으로 바로 로드)
        query = f"SELECT * FROM hourly_stats WHERE target_hour < '{target_date}'"
        df = pd.read_sql(query, conn)
        
        if df.empty:
            print("✅ 아카이빙할 데이터가 없습니다.")
            return {"statusCode": 200, "body": "No data to archive."}
        
        # 날짜 타입 문자열 변환 (Parquet 호환성)
        df['target_hour'] = df['target_hour'].astype(str)
        df['last_event_time'] = df['last_event_time'].astype(str)
        
        # 2. S3에 Parquet 포맷으로 저장 (awswrangler 사용)
        wr.s3.to_parquet(
            df=df,
            path=archive_bucket,
            dataset=True,
            mode="append"
        )
        print(f"✅ S3 Parquet 아카이빙 완료: {len(df)} records")
        
        # 3. 안전하게 S3 저장이 끝났다면 DB에서 삭제
        with conn.cursor() as cursor:
            cursor.execute(f"DELETE FROM hourly_stats WHERE target_hour < '{target_date}'")
        conn.commit()
        print("✅ DB 7일 경과 Cold Data 삭제 완료")
        
        return {"statusCode": 200, "body": f"Archived {len(df)} records successfully."}

    except Exception as e:
        conn.rollback()
        print(f"❌ [ARCHIVE ERROR] {str(e)}")
        raise e
    finally:
        conn.close()