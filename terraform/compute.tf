data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lamda"
  output_path = "${path.module}/lambda_payload.zip"
}

data "archive_file" "layer_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../layer"
  output_path = "${path.module}/layer_payload.zip"
}

resource "aws_iam_role" "lambda_exec_role" {
  name = "factory_lambda_exec_role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_kinesis" {
  role       = aws_iam_role.lambda_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonKinesisReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "lambda_s3_access" {
  role       = aws_iam_role.lambda_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"
}

resource "aws_lambda_layer_version" "factory_common_layer" {
  filename            = data.archive_file.layer_zip.output_path
  source_code_hash    = data.archive_file.layer_zip.output_base64sha256
  layer_name          = "factory-shared-dependencies"
  compatible_runtimes = ["python3.12"]
  description         = "Shared libraries for factory SCADA system"
}

resource "aws_lambda_function" "realtime_detector" {
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  function_name    = "realtime_detector"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "realtime_detector.lambda_handler"
  runtime          = "python3.12"
  timeout          = 30

  environment {
    variables = {
      DB_HOST     = aws_rds_cluster.factory_cluster.endpoint
      DB_PASSWORD = aws_secretsmanager_secret_version.db_password_val.secret_string
      DB_PORT     = "3306"
      TZ          = "Asia/Seoul"
    }
  }

  vpc_config {
    subnet_ids         = [aws_subnet.private_app_a.id, aws_subnet.private_app_c.id]
    security_group_ids = [aws_security_group.streaming_lambda_sg.id]
  }

  layers = [aws_lambda_layer_version.factory_common_layer.arn]
}

resource "aws_lambda_event_source_mapping" "kinesis_to_detector" {
  event_source_arn  = aws_kinesis_stream.factory_logs_stream.arn
  function_name     = aws_lambda_function.realtime_detector.arn
  starting_position = "LATEST"
  maximum_retry_attempts = 3 
  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.lambda_dlq.arn
    }
  }
}

resource "aws_lambda_function" "hourly_aggregator" {
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  function_name    = "hourly_aggregator"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "hourly_aggregator.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  memory_size       = 512

  environment {
    variables = {
      DB_HOST     = aws_rds_cluster.factory_cluster.endpoint
      DB_PASSWORD = aws_secretsmanager_secret_version.db_password_val.secret_string
      DB_PORT     = "3306"
      TZ          = "Asia/Seoul"
    }
  }

  vpc_config {
    subnet_ids         = [aws_subnet.private_app_a.id, aws_subnet.private_app_c.id]
    security_group_ids = [aws_security_group.streaming_lambda_sg.id]
  }
  
  layers = [
    "arn:aws:lambda:ap-northeast-2:336392948345:layer:AWSSDKPandas-Python312:24",
    aws_lambda_layer_version.factory_common_layer.arn
  ]
}

resource "aws_lambda_permission" "allow_s3" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.hourly_aggregator.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.raw_data_bucket.arn
}

resource "aws_s3_bucket_notification" "bucket_notification" {
  bucket = aws_s3_bucket.raw_data_bucket.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.hourly_aggregator.arn
    events              = ["s3:ObjectCreated:*"]
  }
  depends_on = [aws_lambda_permission.allow_s3]
}

resource "aws_cloudwatch_event_rule" "daily_batch_rule" {
  name                = "daily-fatigue-batch"
  schedule_expression = "cron(05 9 * * ? *)"
}

resource "aws_lambda_function" "daily_settlement" {
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  function_name    = "daily_settlement"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "daily_settlement.lambda_handler"
  runtime          = "python3.12"
  timeout          = 300

  environment {
    variables = {
      DB_HOST     = aws_rds_cluster.factory_cluster.endpoint
      DB_PASSWORD = aws_secretsmanager_secret_version.db_password_val.secret_string
      DB_PORT     = "3306"
      TZ          = "Asia/Seoul"
    }
  }
  layers = [aws_lambda_layer_version.factory_common_layer.arn]
}

resource "aws_lambda_function" "fatigue_analysis" {
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  function_name    = "fatigue_analysis"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "fatigue_analysis.lambda_handler"
  runtime          = "python3.12"
  timeout          = 300

  environment {
    variables = {
      DB_HOST     = aws_rds_cluster.factory_cluster.endpoint
      DB_PASSWORD = aws_secretsmanager_secret_version.db_password_val.secret_string
      DB_PORT     = "3306"
      TZ          = "Asia/Seoul"
    }
  }
  layers = [aws_lambda_layer_version.factory_common_layer.arn]
}

resource "aws_iam_role_policy" "lambda_kms_s3_access" {
  name = "lambda_kms_s3_access_policy"
  role = aws_iam_role.lambda_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action = ["kms:Decrypt", "secretsmanager:GetSecretValue"]
        Resource = [
          aws_kms_key.ecr_kms_key.arn,
          aws_secretsmanager_secret.db_password.arn
        ]
      }
    ]
  })
}

resource "aws_iam_role" "sfn_exec_role" {
  name = "factory_sfn_exec_role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "states.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "sfn_lambda_invoke" {
  name = "sfn_lambda_invoke_policy"
  role = aws_iam_role.sfn_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "lambda:InvokeFunction"
      Resource = [
        aws_lambda_function.daily_settlement.arn,
        aws_lambda_function.fatigue_analysis.arn,
        aws_lambda_function.data_archiver.arn
      ]
    }]
  })
}

resource "aws_sfn_state_machine" "batch_etl_pipeline" {
  name     = "DailyBatchETLPipeline"
  role_arn = aws_iam_role.sfn_exec_role.arn

  definition = jsonencode({
    Comment = "공장 일일 정산, 분석 및 데이터 아카이빙 파이프라인"
    StartAt = "DailySettlement"
    States = {
      DailySettlement = {
        Type = "Task"
        Resource = aws_lambda_function.daily_settlement.arn
        Next = "FatigueAnalysis"
        Retry = [{ ErrorEquals = ["States.ALL"], IntervalSeconds = 60, MaxAttempts = 3, BackoffRate = 2.0 }]
      }
      FatigueAnalysis = {
        Type = "Task"
        Resource = aws_lambda_function.fatigue_analysis.arn
        Next = "DataArchive" # 다음 단계 지정
        Retry = [{ ErrorEquals = ["States.ALL"], IntervalSeconds = 60, MaxAttempts = 3, BackoffRate = 2.0 }]
      }
      DataArchive = {
        Type = "Task"
        Resource = aws_lambda_function.data_archiver.arn
        End = true
        Retry = [{ ErrorEquals = ["States.ALL"], IntervalSeconds = 60, MaxAttempts = 3, BackoffRate = 2.0 }]
      }
    }
  })
}

resource "aws_iam_role" "eventbridge_sfn_role" {
  name = "eventbridge_sfn_invoke_role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "events.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "eventbridge_sfn_policy" {
  name = "eventbridge_sfn_policy"
  role = aws_iam_role.eventbridge_sfn_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "states:StartExecution"
      Resource = aws_sfn_state_machine.batch_etl_pipeline.arn
    }]
  })
}

resource "aws_cloudwatch_event_target" "trigger_sfn" {
  rule      = aws_cloudwatch_event_rule.daily_batch_rule.name
  target_id = "TriggerBatchPipeline"
  arn       = aws_sfn_state_machine.batch_etl_pipeline.arn
  role_arn  = aws_iam_role.eventbridge_sfn_role.arn
}

resource "aws_lambda_function" "firehose_transformer" {
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  function_name    = "firehose_transformer"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "firehose_transformer.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
}

resource "aws_lambda_function" "data_archiver" {
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  function_name    = "data_archiver"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "data_archiver.lambda_handler"
  runtime          = "python3.12"
  timeout          = 300
  memory_size      = 512

  environment {
    variables = {
      DB_HOST             = aws_rds_cluster.factory_cluster.endpoint
      DB_PASSWORD         = aws_secretsmanager_secret_version.db_password_val.secret_string
      DB_PORT             = "3306"
      TZ                  = "Asia/Seoul"
      ARCHIVE_BUCKET_PATH = "s3://${aws_s3_bucket.raw_data_bucket.bucket}/archive/hourly_stats/"
    }
  }
  
  layers = [
    "arn:aws:lambda:ap-northeast-2:336392948345:layer:AWSSDKPandas-Python312:24",
    aws_lambda_layer_version.factory_common_layer.arn
  ]
}

# CloudWatch Metrics
resource "aws_iam_role_policy" "lambda_cloudwatch_read_policy" {
  name = "lambda_cloudwatch_read_policy"
  role = aws_iam_role.lambda_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "cloudwatch:GetMetricStatistics",
          "cloudwatch:GetMetricData",
          "cloudwatch:ListMetrics"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_lambda_function" "etl_metrics_api" {
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  function_name    = "etl_metrics_api"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "etl_metrics.lambda_handler"
  runtime          = "python3.12"
  timeout          = 30
}

resource "aws_iam_role_policy" "api_backend_extra_policy" {
  name = "api_backend_extra_policy"
  role = aws_iam_role.lambda_exec_role.id
  
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.lambda_dlq.arn
      },

      {
        Effect = "Allow"
        Action = [
          "kinesis:PutRecord",
          "kinesis:PutRecords"
        ]
        Resource = aws_kinesis_stream.factory_logs_stream.arn
      },

      {
        Effect = "Allow"
        Action = [
          "athena:StartQueryExecution",
          "athena:GetQueryExecution",
          "athena:GetQueryResults"
        ]
        Resource = "*"
      },

      {
        Effect = "Allow"
        Action = [
          "glue:GetDatabase",
          "glue:GetDatabases",
          "glue:GetTable",
          "glue:GetTables",
          "glue:GetPartitions"
        ]
        Resource = "*"
      },

      {
        Effect = "Allow"
        Action = [
          "s3:GetBucketLocation",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:PutObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts"
        ]
        Resource = [
          aws_s3_bucket.raw_data_bucket.arn,
          "${aws_s3_bucket.raw_data_bucket.arn}/*"
        ]
      },

      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey"
        ]
        Resource = aws_kms_key.ecr_kms_key.arn
      },

      {
        Effect = "Allow"
        Action = [
          "ce:GetCostAndUsage"
        ]
        Resource = "*"
      }
    ]
  })
}