resource "aws_security_group" "rds_sg" {
  name   = "factory-rds-sg"
  vpc_id = aws_vpc.factory_vpc.id

  ingress {
    from_port   = 3306
    to_port     = 3306
    protocol    = "tcp"
    cidr_blocks = [
      "10.0.0.0/16",
      var.my_ip
    ]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_subnet_group" "rds_subnet_group" {
  name       = "factory-rds-subnet-group"
  subnet_ids = [aws_subnet.public_1.id, aws_subnet.public_2.id]
}

resource "aws_rds_cluster" "factory_cluster" {
  cluster_identifier     = "factory-aurora-cluster"
  engine                 = "aurora-mysql"
  engine_version         = "8.0.mysql_aurora.3.04.0"
  database_name          = "my_datawarehouse"
  master_username        = "root"
  master_password        = aws_secretsmanager_secret_version.db_password_val.secret_string
  db_subnet_group_name   = aws_db_subnet_group.rds_subnet_group.name
  vpc_security_group_ids = [aws_security_group.rds_sg.id]
  skip_final_snapshot    = true

  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = 2.0
  }
}

resource "aws_rds_cluster_instance" "factory_instance" {
  cluster_identifier  = aws_rds_cluster.factory_cluster.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.factory_cluster.engine
  engine_version      = aws_rds_cluster.factory_cluster.engine_version
  publicly_accessible = true 
}

resource "random_password" "db_password" {
  length           = 16
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_secretsmanager_secret" "db_password" {
  name                    = "factory-db-password-final"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db_password_val" {
  secret_id     = aws_secretsmanager_secret.db_password.id
  secret_string = random_password.db_password.result
}