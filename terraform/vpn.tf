resource "tls_private_key" "ca" {
    algorithm = "RSA"
    rsa_bits  = 2048
}

resource "tls_self_signed_cert" "ca" {
    private_key_pem = tls_private_key.ca.private_key_pem
    subject {
        common_name = "factory-vpn-ca"
    }
    validity_period_hours = 8760
    is_ca_certificate     = true
    allowed_uses          = ["cert_signing", "crl_signing"]
}

resource "tls_private_key" "server" {
    algorithm = "RSA"
    rsa_bits  = 2048
}

resource "tls_cert_request" "server" {
    private_key_pem = tls_private_key.server.private_key_pem
    subject {
        common_name = "factory-vpn-server.com"
    }
    dns_names = ["factory-vpn-server.com"]
}

resource "tls_locally_signed_cert" "server" {
    cert_request_pem      = tls_cert_request.server.cert_request_pem
    ca_private_key_pem    = tls_private_key.ca.private_key_pem
    ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
    validity_period_hours = 8760
    allowed_uses          = ["key_encipherment", "digital_signature", "server_auth"]
}

resource "aws_acm_certificate" "server" {
    private_key       = tls_private_key.server.private_key_pem
    certificate_body  = tls_locally_signed_cert.server.cert_pem
    certificate_chain = tls_self_signed_cert.ca.cert_pem
}

resource "tls_private_key" "client" {
    algorithm = "RSA"
    rsa_bits  = 2048
}

resource "tls_cert_request" "client" {
    private_key_pem = tls_private_key.client.private_key_pem
    subject {
        common_name = "factory-vpn-client.com"
    }
    dns_names = ["factory-vpn-client.com"]
}

resource "tls_locally_signed_cert" "client" {
    cert_request_pem      = tls_cert_request.client.cert_request_pem
    ca_private_key_pem    = tls_private_key.ca.private_key_pem
    ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
    validity_period_hours = 8760
    allowed_uses          = ["key_encipherment", "digital_signature", "client_auth"]
}

resource "aws_acm_certificate" "client" {
    private_key       = tls_private_key.client.private_key_pem
    certificate_body  = tls_locally_signed_cert.client.cert_pem
    certificate_chain = tls_self_signed_cert.ca.cert_pem
}

resource "aws_security_group" "vpn_sg" {
    name   = "factory-vpn-sg"
    vpc_id = aws_vpc.factory_vpc.id

    egress {
        from_port   = 0
        to_port     = 0
        protocol    = "-1"
        cidr_blocks = ["10.0.0.0/16"]
    }
    tags = { Name = "factory-vpn-sg" }
}

resource "aws_ec2_client_vpn_endpoint" "factory_vpn" {
    description            = "Factory Admin Client VPN"
    server_certificate_arn = aws_acm_certificate.server.arn
    client_cidr_block      = "10.1.0.0/22"
    split_tunnel           = true
    security_group_ids     = [aws_security_group.vpn_sg.id]
    vpc_id                 = aws_vpc.factory_vpc.id

    authentication_options {
        type                       = "certificate-authentication"
        root_certificate_chain_arn = aws_acm_certificate.client.arn
    }

    connection_log_options {
        enabled = false
    }
}

resource "aws_ec2_client_vpn_network_association" "vpn_assoc" {
    client_vpn_endpoint_id = aws_ec2_client_vpn_endpoint.factory_vpn.id
    subnet_id              = aws_subnet.private_app_a.id

    timeouts {
        create = "30m"
        delete = "30m"
    }
}

resource "aws_ec2_client_vpn_authorization_rule" "vpn_auth" {
    client_vpn_endpoint_id = aws_ec2_client_vpn_endpoint.factory_vpn.id
    target_network_cidr    = "10.0.0.0/16"
    authorize_all_groups   = true

    timeouts {
        create = "30m"
    }
}