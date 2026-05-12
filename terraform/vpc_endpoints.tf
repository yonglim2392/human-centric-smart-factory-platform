resource "aws_security_group" "vpc_endpoint_sg" {
    name   = "factory-vpc-endpoint-sg"
    vpc_id = aws_vpc.factory_vpc.id

    ingress {
            from_port   = 443
            to_port     = 443
            protocol    = "tcp"
            cidr_blocks = ["10.0.0.0/16"]
            }

    egress {
            from_port   = 0
            to_port     = 0
            protocol    = "-1"
            cidr_blocks = ["0.0.0.0/0"]
            }

    tags = { Name = "factory-vpc-endpoint-sg" }
}

resource "aws_vpc_endpoint" "s3" {
    vpc_id            = aws_vpc.factory_vpc.id
    service_name      = "com.amazonaws.ap-northeast-2.s3"
    vpc_endpoint_type = "Gateway"
    route_table_ids   = [
                        aws_route_table.private_app_rt.id,
                        aws_route_table.private_db_rt.id
                        ]

    tags = { Name = "factory-s3-endpoint" }
}

locals {
        interface_endpoints = [
                                "logs",
                                "kinesis-streams",
                                "ecr.api",
                                "ecr.dkr",
                                "secretsmanager"
                            ]
}

resource "aws_vpc_endpoint" "interfaces" {
    count               = length(local.interface_endpoints)
    vpc_id              = aws_vpc.factory_vpc.id
    service_name        = "com.amazonaws.ap-northeast-2.${local.interface_endpoints[count.index]}"
    vpc_endpoint_type   = "Interface"
    subnet_ids          = [aws_subnet.private_app_a.id, aws_subnet.private_app_c.id]
    security_group_ids  = [aws_security_group.vpc_endpoint_sg.id]
    private_dns_enabled = true

    tags = {
            Name = "factory-${local.interface_endpoints[count.index]}-endpoint"
            }
}