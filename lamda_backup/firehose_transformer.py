import json
import base64
from datetime import datetime

def lambda_handler(event, context):
    output = []
    
    for record in event['records']:
        try:
            # 1. Base64로 인코딩된 원본 데이터 디코딩
            payload = base64.b64decode(record['data']).decode('utf-8')
            data = json.loads(payload)
            
            # --- [데이터 정제(Cleansing) 로직] ---
            
            # (1) 필수 필드 검증: worker_id가 없는 유령 로그는 S3 적재 전 드랍(Drop)
            if 'worker_id' not in data or not data['worker_id']:
                output.append({
                    'recordId': record['recordId'],
                    'result': 'Dropped',
                    'data': record['data']
                })
                continue
            
            # (2) 파생 변수 추가: 데이터 레이크 적재 시간(서버 시간) 기록
            data['processed_at'] = datetime.utcnow().isoformat()
            
            # (3) 이상치 캡핑: duration이 비정상적으로 크면 3600초(1시간)로 제한
            if data.get('duration', 0) > 3600:
                data['duration'] = 3600
                
            # 2. 정제된 데이터를 다시 Base64로 인코딩
            processed_payload = json.dumps(data) + '\n'
            encoded_data = base64.b64encode(processed_payload.encode('utf-8')).decode('utf-8')
            
            output.append({
                'recordId': record['recordId'],
                'result': 'Ok',
                'data': encoded_data
            })
            
        except Exception as e:
            # 파싱 에러 등이 발생한 경우 원본 유지 및 상태 마킹
            print(f"Error processing record: {e}")
            output.append({
                'recordId': record['recordId'],
                'result': 'ProcessingFailed',
                'data': record['data']
            })
            
    return {'records': output}