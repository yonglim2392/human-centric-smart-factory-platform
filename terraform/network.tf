resource "aws_vpc" "factory_vpc" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags = { Name = "scada-factory-vpc" }
}

# ---------------------------------------------------------
# Internet Gateway & NAT Gateway
# ---------------------------------------------------------
resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.factory_vpc.id
  tags   = { Name = "factory-igw" }
}

resource "aws_eip" "nat_eip" {
  domain = "vpc"
  tags   = { Name = "factory-nat-eip" }
}

resource "aws_nat_gateway" "nat_gw" {
  allocation_id = aws_eip.nat_eip.id
  subnet_id     = aws_subnet.public_a.id
  tags          = { Name = "factory-nat-gw" }
}

# ---------------------------------------------------------
# 1. Public Subnets
# ---------------------------------------------------------
resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.factory_vpc.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "ap-northeast-2a"
  map_public_ip_on_launch = true
  tags                    = { Name = "factory-public-2a" }
}

resource "aws_subnet" "public_c" {
  vpc_id                  = aws_vpc.factory_vpc.id
  cidr_block              = "10.0.11.0/24"
  availability_zone       = "ap-northeast-2c"
  map_public_ip_on_launch = true
  tags                    = { Name = "factory-public-2c" }
}

# ---------------------------------------------------------
# 2. Private App Subnets
# ---------------------------------------------------------
resource "aws_subnet" "private_app_a" {
  vpc_id                  = aws_vpc.factory_vpc.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = "ap-northeast-2a"
  map_public_ip_on_launch = false
  tags                    = { Name = "factory-private-app-2a" }
}

resource "aws_subnet" "private_app_c" {
  vpc_id                  = aws_vpc.factory_vpc.id
  cidr_block              = "10.0.22.0/24"
  availability_zone       = "ap-northeast-2c"
  map_public_ip_on_launch = false
  tags                    = { Name = "factory-private-app-2c" }
}

# ---------------------------------------------------------
# 3. Private DB Subnets
# ---------------------------------------------------------
resource "aws_subnet" "private_db_a" {
  vpc_id                  = aws_vpc.factory_vpc.id
  cidr_block              = "10.0.3.0/24"
  availability_zone       = "ap-northeast-2a"
  map_public_ip_on_launch = false
  tags                    = { Name = "factory-private-db-2a" }
}

resource "aws_subnet" "private_db_c" {
  vpc_id                  = aws_vpc.factory_vpc.id
  cidr_block              = "10.0.33.0/24"
  availability_zone       = "ap-northeast-2c"
  map_public_ip_on_launch = false
  tags                    = { Name = "factory-private-db-2c" }
}

# ---------------------------------------------------------
# Route Tables & Associations
# ---------------------------------------------------------
# Public Route Table (IGW Connect)
resource "aws_route_table" "public_rt" {
  vpc_id = aws_vpc.factory_vpc.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
  tags = { Name = "factory-public-rt" }
}

resource "aws_route_table_association" "pub_a_assoc" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public_rt.id
}
resource "aws_route_table_association" "pub_c_assoc" {
  subnet_id      = aws_subnet.public_c.id
  route_table_id = aws_route_table.public_rt.id
}

# Private App Route Table (NAT GW Connect)
resource "aws_route_table" "private_app_rt" {
  vpc_id = aws_vpc.factory_vpc.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat_gw.id
  }
  tags = { Name = "factory-private-app-rt" }
}

resource "aws_route_table_association" "priv_app_a_assoc" {
  subnet_id      = aws_subnet.private_app_a.id
  route_table_id = aws_route_table.private_app_rt.id
}
resource "aws_route_table_association" "priv_app_c_assoc" {
  subnet_id      = aws_subnet.private_app_c.id
  route_table_id = aws_route_table.private_app_rt.id
}

# Private DB Route Table
resource "aws_route_table" "private_db_rt" {
  vpc_id = aws_vpc.factory_vpc.id
  tags   = { Name = "factory-private-db-rt" }
}

resource "aws_route_table_association" "priv_db_a_assoc" {
  subnet_id      = aws_subnet.private_db_a.id
  route_table_id = aws_route_table.private_db_rt.id
}
resource "aws_route_table_association" "priv_db_c_assoc" {
  subnet_id      = aws_subnet.private_db_c.id
  route_table_id = aws_route_table.private_db_rt.id
}