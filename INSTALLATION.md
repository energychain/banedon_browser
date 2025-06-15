# Browser Automation Service - Production Installation Guide

This guide provides step-by-step instructions for deploying the Browser Automation Service on server 10.0.0.2.

## 📋 Prerequisites

### Server Requirements
- Linux server (Ubuntu 20.04+ recommended)
- Docker 20.10+ and Docker Compose v2+
- Git
- Minimum 2GB RAM, 1 CPU core
- At least 5GB free disk space

### Network Requirements
- Server accessible at IP: 10.0.0.2
- Required public ports (see Port Configuration section)
- Internet access for Docker image pulls

## 🚀 Installation Steps

### 1. Clone Repository

```bash
# SSH into your server (10.0.0.2)
ssh user@10.0.0.2

# Clone the repository
git clone <your-repository-url> browser-automation-service
cd browser-automation-service

# Verify files are present
ls -la
```

### 2. Environment Configuration

Create production environment file:

```bash
# Copy the example environment file
cp .env .env.production

# Edit production configuration
nano .env.production
```

Update the `.env.production` file with production settings:

```properties
# Server Configuration
PORT=3010
NODE_ENV=production

# Session Configuration
SESSION_TIMEOUT=1800000
SESSION_CLEANUP_INTERVAL=300000
MAX_SESSIONS=100

# Command Configuration
COMMAND_TIMEOUT=30000
MAX_COMMAND_QUEUE_SIZE=50

# WebSocket Configuration
WS_HEARTBEAT_INTERVAL=30000
WS_CONNECTION_TIMEOUT=60000

# Security Configuration
ALLOWED_ORIGINS=http://10.0.0.2:3010,https://10.0.0.2:3010,chrome-extension://,moz-extension://
API_RATE_LIMIT=100

# Logging Configuration
LOG_LEVEL=info
LOG_FILE_PATH=/app/logs/app.log
```

### 3. Docker Deployment

#### Option A: Simple Deployment (HTTP only)

```bash
# Build and start the service
docker-compose up -d browser-automation-service

# Check if service is running
docker-compose ps
docker-compose logs browser-automation-service
```

#### Option B: Production Deployment with NGINX (HTTP/HTTPS)

First, create an nginx configuration:

```bash
# Create nginx configuration
cat > nginx.conf << 'EOF'
events {
    worker_connections 1024;
}

http {
    upstream backend {
        server browser-automation-service:3010;
    }

    server {
        listen 80;
        server_name 10.0.0.2;

        # Security headers
        add_header X-Frame-Options DENY;
        add_header X-Content-Type-Options nosniff;
        add_header X-XSS-Protection "1; mode=block";

        # API and WebSocket proxy
        location / {
            proxy_pass http://backend;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_cache_bypass $http_upgrade;
        }
    }

    # Optional HTTPS configuration (if you have SSL certificates)
    # server {
    #     listen 443 ssl;
    #     server_name 10.0.0.2;
    #     
    #     ssl_certificate /etc/nginx/ssl/cert.pem;
    #     ssl_certificate_key /etc/nginx/ssl/key.pem;
    #     
    #     location / {
    #         proxy_pass http://backend;
    #         proxy_http_version 1.1;
    #         proxy_set_header Upgrade $http_upgrade;
    #         proxy_set_header Connection 'upgrade';
    #         proxy_set_header Host $host;
    #         proxy_set_header X-Real-IP $remote_addr;
    #         proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    #         proxy_set_header X-Forwarded-Proto $scheme;
    #         proxy_cache_bypass $http_upgrade;
    #     }
    # }
}
EOF

# Start with nginx proxy
docker-compose --profile production up -d

# Check all services
docker-compose ps
```

### 4. Verify Installation

#### Check Service Health
```bash
# Test health endpoint
curl http://10.0.0.2:3010/health

# Expected response:
# {"status":"healthy","timestamp":"2024-01-XX...","uptime":XXX}

# If using nginx proxy:
curl http://10.0.0.2/health
```

#### Test API Endpoints
```bash
# Create a test session
curl -X POST http://10.0.0.2:3010/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"metadata":{"browser":"chrome","purpose":"installation-test"}}'

# Should return session details with ID
```

#### Check Logs
```bash
# View application logs
docker-compose logs browser-automation-service

# View nginx logs (if using proxy)
docker-compose logs nginx

# Follow logs in real-time
docker-compose logs -f browser-automation-service
```

## 🌐 Port Configuration

### Required Public Ports

The following ports must be accessible from client machines:

#### Option A: Direct Access (Simple Deployment)
- **Port 3010 (TCP)**: HTTP API and WebSocket connections
  - **Purpose**: Main application port for browser extension and API clients
  - **Protocol**: HTTP/WebSocket
  - **Required for**: Browser extension communication, API access, WebSocket real-time updates

#### Option B: Reverse Proxy (Production Deployment)
- **Port 80 (TCP)**: HTTP access via NGINX proxy
  - **Purpose**: HTTP traffic proxied to backend service
  - **Protocol**: HTTP
  - **Required for**: Browser extension communication, API access
- **Port 443 (TCP)**: HTTPS access via NGINX proxy (optional)
  - **Purpose**: Secure HTTPS traffic proxied to backend service
  - **Protocol**: HTTPS
  - **Required for**: Secure browser extension communication, secure API access

### Firewall Configuration

#### Ubuntu/Debian (ufw):
```bash
# For direct access (Option A):
sudo ufw allow 3010/tcp

# For reverse proxy (Option B):
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp  # If using HTTPS

# Check firewall status
sudo ufw status
```

#### CentOS/RHEL (firewalld):
```bash
# For direct access (Option A):
sudo firewall-cmd --permanent --add-port=3010/tcp

# For reverse proxy (Option B):
sudo firewall-cmd --permanent --add-port=80/tcp
sudo firewall-cmd --permanent --add-port=443/tcp  # If using HTTPS

sudo firewall-cmd --reload
```

### Cloud Provider Security Groups

If using cloud providers (AWS, GCP, Azure), ensure security groups allow:
- **Inbound TCP 3010** (Option A) or **TCP 80/443** (Option B)
- **Source**: Client IP ranges or 0.0.0.0/0 for public access

## 🔧 Browser Extension Installation

### For End Users

1. **Build Extension Package** (on development machine):
   ```bash
   # In the project directory
   chmod +x build.sh
   ./build.sh
   
   # Extension package will be in build/extension-package.zip
   ```

2. **Distribute to Users**:
   - Send `build/extension-package.zip` to users
   - Provide installation instructions

3. **User Installation**:
   ```
   1. Download and extract extension-package.zip
   2. Open Chrome → Extensions (chrome://extensions/)
   3. Enable "Developer mode" (top right)
   4. Click "Load unpacked"
   5. Select the extracted extension folder
   6. Extension icon appears in toolbar
   ```

4. **Extension Configuration**:
   ```
   1. Click extension icon
   2. Enter server URL: http://10.0.0.2:3010 (or http://10.0.0.2 if using nginx)
   3. Create session via API first, then enter session ID
   4. Click "Connect"
   ```

## 🔒 Security Considerations

### Recommended Security Settings

1. **Environment Variables**:
   ```bash
   # Restrict CORS origins in production
   ALLOWED_ORIGINS=http://10.0.0.2:3010,https://10.0.0.2:3010,chrome-extension://
   
   # Set rate limiting
   API_RATE_LIMIT=100
   
   # Limit session resources
   MAX_SESSIONS=50
   SESSION_TIMEOUT=1800000  # 30 minutes
   ```

2. **Network Security**:
   - Use HTTPS in production (set up SSL certificates)
   - Restrict access by IP if possible
   - Consider VPN access for sensitive environments

3. **Docker Security**:
   - Run containers as non-root user (already configured)
   - Regularly update base images
   - Limit container resources

### SSL/HTTPS Setup (Optional)

If you have SSL certificates:

1. **Create SSL directory**:
   ```bash
   mkdir -p ssl
   ```

2. **Copy certificates**:
   ```bash
   # Copy your certificates to ssl/ directory
   cp /path/to/your/cert.pem ssl/
   cp /path/to/your/private.key ssl/key.pem
   ```

3. **Update nginx.conf** (uncomment HTTPS server block)

4. **Update ALLOWED_ORIGINS** in `.env.production`:
   ```
   ALLOWED_ORIGINS=https://10.0.0.2,chrome-extension://,moz-extension://
   ```

## 📊 Monitoring and Maintenance

### Health Monitoring

```bash
# Check service health
curl http://10.0.0.2:3010/health

# Monitor Docker containers
docker-compose ps
docker stats

# View resource usage
docker-compose exec browser-automation-service ps aux
```

### Log Management

```bash
# View recent logs
docker-compose logs --tail=50 browser-automation-service

# Log rotation (add to crontab)
# Logs are stored in ./logs/ directory
0 2 * * * cd /path/to/browser-automation-service && find ./logs -name "*.log" -mtime +7 -delete
```

### Updating the Service

```bash
# Pull latest changes
git pull origin main

# Rebuild and restart
docker-compose down
docker-compose up -d --build

# Verify update
curl http://10.0.0.2:3010/health
```

## 🛠 Troubleshooting

### Common Issues

1. **Service won't start**:
   ```bash
   # Check logs
   docker-compose logs browser-automation-service
   
   # Check port conflicts
   sudo netstat -tlnp | grep 3010
   ```

2. **Extension can't connect**:
   - Verify server URL in extension
   - Check CORS settings in `.env.production`
   - Confirm firewall allows required ports
   - Test API directly: `curl http://10.0.0.2:3010/health`

3. **WebSocket connection fails**:
   - Check nginx WebSocket proxy configuration
   - Verify no intermediary proxies blocking WebSocket upgrades
   - Check browser console for connection errors

4. **High memory usage**:
   - Reduce `MAX_SESSIONS` in environment
   - Decrease `SESSION_TIMEOUT`
   - Monitor with: `docker stats`

### Getting Help

- Check logs: `docker-compose logs browser-automation-service`
- Verify configuration: `docker-compose config`
- Test network connectivity: `curl -v http://10.0.0.2:3010/health`

## 📝 Production Checklist

- [ ] Server meets minimum requirements
- [ ] Repository cloned and configured
- [ ] Production environment variables set
- [ ] Firewall ports opened (3010 or 80/443)
- [ ] Docker containers running successfully
- [ ] Health endpoint responding
- [ ] API endpoints accessible
- [ ] Browser extension built and distributed
- [ ] HTTPS configured (if required)
- [ ] Monitoring setup
- [ ] Backup strategy implemented

---

**Service URLs for clients:**
- **Direct access**: `http://10.0.0.2:3010`
- **Reverse proxy**: `http://10.0.0.2` (or `https://10.0.0.2` with SSL)

**Important**: Clients (browser extensions) must use these URLs to connect to the service.
