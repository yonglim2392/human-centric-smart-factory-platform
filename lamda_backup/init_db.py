import os
import random
import pymysql

# 람다 컨테이너가 살아있는 동안 유지할 글로벌 커넥션
_global_conn = None

def get_db_conn():
    global _global_conn
    
    # 커넥션이 아예 없거나, 끊어진(Timeout 등) 상태라면 새로 연결
    if _global_conn is None or not _global_conn.open:
        db_host = os.environ.get('DB_HOST', 'host.docker.internal')
        db_pw = os.environ.get('DB_PASSWORD', 'TestPassword123!')
        db_port = int(os.environ.get('DB_PORT', 13306))

        try:
            _global_conn = pymysql.connect(
                host=db_host,
                user='root',
                password=db_pw,
                port=db_port,
                db='my_datawarehouse',
                charset='utf8mb4',
                connect_timeout=5
            )
            print("새로운 DB 커넥션 생성 완료")
        except Exception as e:
            print(f"DB 커넥션 에러: {e}")
            raise e
            
    return _global_conn