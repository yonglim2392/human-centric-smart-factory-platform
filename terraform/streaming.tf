resource "aws_glue_catalog_database" "factory_data_lake" {
  name = "factory_data_lake_db"
}

resource "aws_glue_catalog_table" "factory_logs_parquet" {
  name          = "factory_logs_parquet"
  database_name = aws_glue_catalog_database.factory_data_lake.name
  table_type    = "EXTERNAL_TABLE"

  parameters = {
    "classification" = "parquet"
  }

  storage_descriptor {
    location      = "s3://${aws_s3_bucket.raw_data_bucket.bucket}/"
    input_format  = "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat"

    ser_de_info {
      name                  = "my-stream"
      serialization_library = "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe"
      parameters = {
        "serialization.format" = "1"
      }
    }

    # 정제된 JSON 데이터의 스키마 정의
    columns {
      name = "worker_id"
      type = "string"
      }
    columns {
      name = "line_id"
      type = "string"
      }
    columns {
      name = "process_id"
      type = "string"
      }
    columns {
      name = "status"
      type = "string"
      }
    columns {
      name = "start_time"
      type = "string"
      }
    columns {
      name = "timestamp"
      type = "string"
      }
    columns {
      name = "current_amp"
      type = "double"
      }
    columns {
      name = "duration"
      type = "double"
      }
    columns {
      name = "processed_at"
      type = "string"
      }
}
}

resource "aws_kinesis_stream" "factory_logs_stream" {
  name             = "factory_logs"
  shard_count      = 1
  retention_period = 24

  encryption_type = "KMS"
  kms_key_id      = aws_kms_key.ecr_kms_key.arn
}

resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

resource "aws_s3_bucket" "raw_data_bucket" {
  bucket = "scada-factory-raw-data-bucket-${random_string.suffix.result}"
  force_destroy = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "raw_data_encryption" {
  bucket = aws_s3_bucket.raw_data_bucket.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.ecr_kms_key.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_iam_role" "firehose_role" {
  name = "firehose_delivery_role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "firehose.amazonaws.com" } }]
  })
}

resource "aws_kinesis_firehose_delivery_stream" "s3_delivery" {
  name        = "factory-logs-delivery"
  destination = "extended_s3"

  kinesis_source_configuration {
    kinesis_stream_arn = aws_kinesis_stream.factory_logs_stream.arn
    role_arn           = aws_iam_role.firehose_role.arn
  }

  extended_s3_configuration {
    role_arn   = aws_iam_role.firehose_role.arn
    bucket_arn = aws_s3_bucket.raw_data_bucket.arn
    custom_time_zone = "Asia/Seoul"
    buffering_interval = 300
    buffering_size     = 64

    processing_configuration {
      enabled = true
      processors {
        type = "Lambda"
        parameters {
          parameter_name  = "LambdaArn"
          parameter_value = "${aws_lambda_function.firehose_transformer.arn}:$LATEST"
        }
      }
    }
    data_format_conversion_configuration {
      input_format_configuration {
        deserializer {
          open_x_json_ser_de {}
        }
      }

      output_format_configuration {
        serializer {
          parquet_ser_de {}
        }
      }

      schema_configuration {
        database_name = aws_glue_catalog_database.factory_data_lake.name
        table_name    = aws_glue_catalog_table.factory_logs_parquet.name
        role_arn      = aws_iam_role.firehose_role.arn
      }
    }
  }
}

resource "aws_iam_role_policy" "firehose_policy" {
  name = "firehose_policy"
  role = aws_iam_role.firehose_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "kinesis:DescribeStream",
          "kinesis:GetShardIterator",
          "kinesis:GetRecords",
          "kinesis:ListShards"
        ]
        Resource = aws_kinesis_stream.factory_logs_stream.arn
      },
      {
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:GetBucketLocation",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:ListBucketMultipartUploads",
          "s3:PutObject"
        ]
        Resource = [
          aws_s3_bucket.raw_data_bucket.arn,
          "${aws_s3_bucket.raw_data_bucket.arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.ecr_kms_key.arn
      },
      {
        Effect = "Allow"
        Action = [
          "lambda:InvokeFunction",
          "lambda:GetFunctionConfiguration"
        ]
        Resource = "${aws_lambda_function.firehose_transformer.arn}:*"
      },
      {
        Effect = "Allow"
        Action = [
          "glue:GetTable",
          "glue:GetTableVersion",
          "glue:GetTableVersions"
        ]
        Resource = [
          aws_glue_catalog_database.factory_data_lake.arn,
          aws_glue_catalog_table.factory_logs_parquet.arn,
          "arn:aws:glue:*:*:catalog"
        ]
      }
    ]
  })
}

resource "aws_s3_bucket_policy" "raw_data_policy" {
  bucket = aws_s3_bucket.raw_data_bucket.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "StrictDenyExternalAccess"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.raw_data_bucket.arn,
          "${aws_s3_bucket.raw_data_bucket.arn}/*"
        ]
        Condition = {
          StringNotLike = {
            "aws:PrincipalArn" = [
              "arn:aws:iam::827913617635:user/de-ai-16",
              aws_iam_role.firehose_role.arn,
              aws_iam_role.lambda_exec_role.arn,
              "arn:aws:iam::827913617635:root"
            ]
          }
        }
      }
    ]
  })
}

resource "aws_kinesis_resource_policy" "stream_policy" {
  resource_arn = aws_kinesis_stream.factory_logs_stream.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "BlockDataViewerForOthers"
        Effect = "Deny"
        Principal = { AWS = "arn:aws:iam::827913617635:root" }
        Action = [
          "kinesis:GetRecords",
          "kinesis:GetShardIterator",
          "kinesis:DescribeStream"
        ]
        Resource = aws_kinesis_stream.factory_logs_stream.arn
        Condition = {
          StringNotLike = {
            "aws:PrincipalArn" = [
              "arn:aws:iam::827913617635:user/de-ai-16",
              aws_iam_role.ecs_task_role.arn,
              aws_iam_role.firehose_role.arn,
              aws_iam_role.lambda_exec_role.arn,
              "arn:aws:iam::827913617635:root"
            ]
          }
        }
      }
    ]
  })
}

resource "aws_athena_workgroup" "factory_analytics" {
  name = "factory_analytics_workgroup"

  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = true

    result_configuration {
      output_location = "s3://${aws_s3_bucket.raw_data_bucket.bucket}/athena-results/"
    }
  }
}

# 아카이빙된 데이터를 조회하기 위한 외부 테이블 (Glue)
resource "aws_glue_catalog_table" "archived_hourly_stats" {
  name          = "archived_hourly_stats"
  database_name = aws_glue_catalog_database.factory_data_lake.name
  table_type    = "EXTERNAL_TABLE"

  parameters = { "classification" = "parquet" }

  storage_descriptor {
    location      = "s3://${aws_s3_bucket.raw_data_bucket.bucket}/archive/hourly_stats/"
    input_format  = "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat"

    ser_de_info {
      name                  = "my-stream"
      serialization_library = "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe"
      parameters = { "serialization.format" = "1" }
    }

    columns {
      name = "line_id"
      type = "string"
      }
    columns {
      name = "process_id"
      type = "string"
      }
    columns {
      name = "worker_id"
      type = "string"
      }
    columns {
      name = "target_hour"
      type = "string"
      }
    columns {
      name = "total_duration"
      type = "double"
      }
    columns {
      name = "total_qty"
      type = "int"
      }
    columns {
      name = "anomaly_count"
      type = "int"
      }
    columns {
      name = "last_event_time"
      type = "string"
      }
  }
}

resource "aws_sqs_queue" "lambda_dlq" {
  name = "factory-lambda-error-dlq"
}

resource "aws_iam_role_policy" "lambda_sqs_dlq_policy" {
  name = "lambda_sqs_dlq_policy"
  role = aws_iam_role.lambda_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "sqs:SendMessage"
        Resource = aws_sqs_queue.lambda_dlq.arn
      }
    ]
  })
}