resource "aws_s3_bucket" "frontend_bucket" {
  bucket = "scada-factory-frontend-${random_string.suffix.result}"
  force_destroy = true
}

resource "aws_s3_bucket_website_configuration" "frontend_website" {
  bucket = aws_s3_bucket.frontend_bucket.id
  index_document { suffix = "index.html" }
}

resource "aws_s3_bucket_public_access_block" "frontend_public_access" {
  bucket                  = aws_s3_bucket.frontend_bucket.id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "frontend_policy" {
  depends_on = [aws_s3_bucket_public_access_block.frontend_public_access]
  bucket     = aws_s3_bucket.frontend_bucket.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "s3:GetObject"
      Effect    = "Allow"
      Principal = "*"
      Resource  = "${aws_s3_bucket.frontend_bucket.arn}/*"
    }]
  })
}

data "archive_file" "api_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lamda"
  output_path = "${path.module}/api_payload.zip"
}

resource "aws_lambda_function" "api_backend" {
  filename         = data.archive_file.api_zip.output_path
  source_code_hash = data.archive_file.api_zip.output_base64sha256
  function_name    = "scada_api_backend"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "api_lambda.lambda_handler"
  runtime          = "python3.12"
  timeout          = 30
  memory_size      = 1024

  layers = [
    "arn:aws:lambda:ap-northeast-2:336392948345:layer:AWSSDKPandas-Python312:24",
    aws_lambda_layer_version.factory_common_layer.arn
  ]
  
  depends_on = [aws_lambda_layer_version.factory_common_layer]

  environment {
    variables = {
      DB_HOST     = aws_rds_cluster.factory_cluster.endpoint
      DB_PASSWORD = aws_secretsmanager_secret_version.db_password_val.secret_string
      DB_PORT     = "3306"
      TZ = "Asia/Seoul"
    }
  }
}

resource "aws_apigatewayv2_api" "backend_api" {
  name          = "scada-backend-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["content-type", "authorization"]
  }
}

resource "aws_apigatewayv2_integration" "lambda_integration" {
  api_id           = aws_apigatewayv2_api.backend_api.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.api_backend.invoke_arn
}

resource "aws_apigatewayv2_route" "default_route" {
  api_id    = aws_apigatewayv2_api.backend_api.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.backend_api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api_gw" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api_backend.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.backend_api.execution_arn}/*/*"
}

output "website_url" {
  value = "http://${aws_s3_bucket.frontend_bucket.bucket_regional_domain_name}"
}

output "api_endpoint" {
  value = aws_apigatewayv2_api.backend_api.api_endpoint
}

# API 통합 설정
resource "aws_apigatewayv2_integration" "metrics_integration" {
  api_id           = aws_apigatewayv2_api.backend_api.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.etl_metrics_api.invoke_arn
}

# 라우트 추가
resource "aws_apigatewayv2_route" "metrics_route" {
  api_id    = aws_apigatewayv2_api.backend_api.id
  route_key = "GET /api/metrics"
  target    = "integrations/${aws_apigatewayv2_integration.metrics_integration.id}"
}

# API Gateway 권한 허용 추가
resource "aws_lambda_permission" "metrics_api_gw" {
  statement_id  = "AllowExecutionFromAPIGatewayMetrics"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.etl_metrics_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.backend_api.execution_arn}/*/*"
}