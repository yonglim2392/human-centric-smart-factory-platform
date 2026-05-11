resource "aws_kms_key" "ecr_kms_key" {
  description             = "KMS Key for Factory Data Generator ECR Encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true
}

resource "aws_kms_alias" "ecr_kms_alias" {
  name          = "alias/factory-ecr-key"
  target_key_id = aws_kms_key.ecr_kms_key.key_id
}

resource "aws_ecs_cluster" "factory_cluster" {
  name = "factory-producer-cluster"
}

resource "aws_ecr_repository" "producer_repo" {
  name                 = "factory-producer-repo"

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.ecr_kms_key.arn
  }
  
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

resource "null_resource" "docker_build_and_push" {
  depends_on = [aws_ecr_repository.producer_repo]

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command = "aws ecr get-login-password --region ap-northeast-2 | docker login --username AWS --password-stdin ${aws_ecr_repository.producer_repo.repository_url} && docker build -t factory-producer-repo ${path.module}/../ecs/ && docker tag factory-producer-repo:latest ${aws_ecr_repository.producer_repo.repository_url}:latest && docker push ${aws_ecr_repository.producer_repo.repository_url}:latest"
  }
}

resource "aws_iam_role" "ecs_task_execution_role" {
  name = "ecsTaskExecutionRole"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_kms_decrypt_policy" {
  name   = "ecs-kms-decrypt-policy"
  role   = aws_iam_role.ecs_task_execution_role.id 

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action = ["kms:Decrypt", "kms:GenerateDataKey", "secretsmanager:GetSecretValue"]
        Resource = [
          aws_kms_key.ecr_kms_key.arn,
          aws_secretsmanager_secret.db_password.arn
        ]
      }
    ]
  })
}

resource "aws_iam_role" "ecs_task_role" {
  name = "ecsTaskRole"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_kinesis_access" {
  role       = aws_iam_role.ecs_task_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonKinesisFullAccess"
}

resource "aws_iam_role_policy" "ecs_task_kms_policy" {
  name   = "ecs-task-kms-policy"
  role   = aws_iam_role.ecs_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.ecr_kms_key.arn
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "ecs_log_group" {
  name              = "/ecs/producer"
  retention_in_days = 7
}

resource "aws_ecs_task_definition" "producer_task" {
  family                   = "factory-producer-task"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_task_execution_role.arn
  task_role_arn            = aws_iam_role.ecs_task_role.arn

  depends_on = [null_resource.docker_build_and_push]

  container_definitions = jsonencode([
    {
      name      = "producer-container"
      image     = "${aws_ecr_repository.producer_repo.repository_url}:latest"
      essential = true
      
      environment = [
        { name = "DB_HOST", value = aws_rds_cluster.factory_cluster.endpoint },
        { name = "DB_PASSWORD", value = aws_secretsmanager_secret_version.db_password_val.secret_string },
        { name = "DB_PORT", value = "3306" },
        { name = "DB_NAME", value = "my_datawarehouse" },
        { "name" : "TZ", "value" : "Asia/Seoul" }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/producer"
          "awslogs-region"        = "ap-northeast-2"
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "producer_service" {
  name            = "factory-producer-service"
  cluster         = aws_ecs_cluster.factory_cluster.id
  task_definition = aws_ecs_task_definition.producer_task.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  depends_on = [aws_rds_cluster_instance.factory_instance]

  network_configuration {
    subnets          = [aws_subnet.public_1.id, aws_subnet.public_2.id]
    security_groups  = [aws_security_group.rds_sg.id]
    assign_public_ip = true
  }
}

resource "aws_appautoscaling_target" "ecs_target" {
  max_capacity       = 1
  min_capacity       = 0
  resource_id        = "service/${aws_ecs_cluster.factory_cluster.name}/${aws_ecs_service.producer_service.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_scheduled_action" "ecs_start_morning" {
  name               = "ecs-start-9am"
  service_namespace  = aws_appautoscaling_target.ecs_target.service_namespace
  resource_id        = aws_appautoscaling_target.ecs_target.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs_target.scalable_dimension
  
  schedule = "cron(0 0 * * ? *)"

  scalable_target_action {
    min_capacity = 1
    max_capacity = 1
  }
}

resource "aws_appautoscaling_scheduled_action" "ecs_stop_evening" {
  name               = "ecs-stop-6pm"
  service_namespace  = aws_appautoscaling_target.ecs_target.service_namespace
  resource_id        = aws_appautoscaling_target.ecs_target.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs_target.scalable_dimension
  
  schedule = "cron(0 09 * * ? *)"

  scalable_target_action {
    min_capacity = 0
    max_capacity = 0
  }
}