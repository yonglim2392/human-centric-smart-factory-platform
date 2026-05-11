import json
import boto3
from datetime import datetime, timedelta

cw_client = boto3.client('cloudwatch', region_name='ap-northeast-2')

def get_metric(namespace, metric_name, stat, dimensions, period=300):
    # CloudWatch 집계 지연(3~5분)을 고려하여 최근 15분 구간을 조회
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(minutes=15)
    
    try:
        response = cw_client.get_metric_statistics(
            Namespace=namespace,
            MetricName=metric_name,
            Dimensions=dimensions,
            StartTime=start_time,
            EndTime=end_time,
            Period=period,
            Statistics=[stat]
        )
        datapoints = response['Datapoints']
        if not datapoints:
            return 0
        
        # Timestamp 기준으로 정렬하여 가장 최신(방금 전 집계된) 데이터를 반환
        datapoints.sort(key=lambda x: x['Timestamp'], reverse=True)
        return round(datapoints[0][stat], 2)
    except Exception as e:
        print(f"Error fetching {metric_name}: {e}")
        return 0

def get_today_sum(namespace, metric_name, dimensions):
    now_utc = datetime.utcnow()
    now_kst = now_utc + timedelta(hours=9)
    # 오늘 KST 00:00:00 계산
    start_of_today_kst = now_kst.replace(hour=0, minute=0, second=0, microsecond=0)
    # CloudWatch 조회를 위해 다시 UTC로 변환
    start_time_utc = start_of_today_kst - timedelta(hours=9)
    
    try:
        response = cw_client.get_metric_statistics(
            Namespace=namespace, MetricName=metric_name, Dimensions=dimensions,
            StartTime=start_time_utc, EndTime=now_utc, Period=300, Statistics=['Sum']
        )
        datapoints = response['Datapoints']
        if not datapoints: return 0
        # 하루치 모든 5분 단위 데이터의 합을 구함
        return int(sum(dp['Sum'] for dp in datapoints))
    except Exception as e:
        print(f"Error fetching today {metric_name}: {e}")
        return 0
    
def lambda_handler(event, context):
    try:
        # 1. ECS (CPU Utilization)
        ecs_cpu = get_metric('AWS/ECS', 'CPUUtilization', 'Average', [
                                {'Name': 'ClusterName', 'Value': 'factory-producer-cluster'},
                                {'Name': 'ServiceName', 'Value': 'factory-producer-service'} # ★ 이 조건이 필수로 들어가야 함!
                            ])
        
        # 2. Kinesis (IteratorAge, Put 성공 건수)
        kinesis_age = get_metric('AWS/Kinesis', 'GetRecords.IteratorAgeMilliseconds', 'Maximum', [{'Name': 'StreamName', 'Value': 'factory_logs'}])
        kinesis_put = get_metric('AWS/Kinesis', 'PutRecords.SuccessfulRecords', 'Sum', [{'Name': 'StreamName', 'Value': 'factory_logs'}])
        
        # 3. Firehose (S3 전송 크기)
        firehose_bytes = get_metric('AWS/Firehose', 'DeliveryToS3.Bytes', 'Sum', [{'Name': 'DeliveryStreamName', 'Value': 'factory-logs-delivery'}])
        
        # 4. RDS Aurora (커넥션 수)
        rds_conn = get_metric('AWS/RDS', 'DatabaseConnections', 'Maximum', [{'Name': 'DBClusterIdentifier', 'Value': 'factory-aurora-cluster'}])

        # 5. 신규 추가: 두 람다의 지표 조회
        detector_invokes = get_today_sum('AWS/Lambda', 'Invocations', [{'Name': 'FunctionName', 'Value': 'realtime_detector'}])
        detector_errors = get_metric('AWS/Lambda', 'Errors', 'Sum', [{'Name': 'FunctionName', 'Value': 'realtime_detector'}])
        
        aggregator_invokes = get_today_sum('AWS/Lambda', 'Invocations', [{'Name': 'FunctionName', 'Value': 'hourly_aggregator'}])
        aggregator_errors = get_metric('AWS/Lambda', 'Errors', 'Sum', [{'Name': 'FunctionName', 'Value': 'hourly_aggregator'}])

        metrics = {
            "tps": round(kinesis_put / 300, 2) if kinesis_put else 0.0, 
            "iterAge": int(kinesis_age),
            "dropRate": 0.0,
            "s3Put": round(firehose_bytes / 1024, 2) if firehose_bytes else 0.0, 
            "dbConn": int(rds_conn),
            "ecsCpu": ecs_cpu,
            "detectorRate": detector_invokes,
            "detectorErr": int(detector_errors),
            "aggregatorRate": aggregator_invokes,
            "aggregatorErr": int(aggregator_errors)
        }

        return {
            "statusCode": 200,
            "headers": { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
            "body": json.dumps({"status": "success", "metrics": metrics})
        }
    except Exception as e:
        return { "statusCode": 500, "body": json.dumps({"status": "error", "message": str(e)}) }