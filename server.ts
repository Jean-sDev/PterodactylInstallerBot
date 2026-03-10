import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { Client } from 'ssh2';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// In-memory store for bot state
const userStates = new Map<number, any>();

// Serve a simple page to keep the container healthy and inform the user
app.get('*', (req, res) => {
  res.send(`
    <html>
      <body style="font-family: sans-serif; padding: 2rem; background: #0f172a; color: #f8fafc; text-align: center;">
        <h1>Pterodactyl Installer Bot</h1>
        <p>Le bot Telegram est en cours d'exécution.</p>
        <p style="color: #94a3b8;">Assurez-vous d'avoir configuré la variable d'environnement <code>TELEGRAM_BOT_TOKEN</code>.</p>
      </body>
    </html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("⚠️ TELEGRAM_BOT_TOKEN n'est pas défini dans les variables d'environnement.");
} else {
  const bot = new TelegramBot(token, { polling: true });
  console.log("✅ Bot Telegram démarré avec succès.");
  setupBotLogic(bot);
}

function setupBotLogic(bot: TelegramBot) {
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    userStates.set(chatId, { step: 'IDLE' });
    bot.sendMessage(chatId, "Bienvenue sur le bot d'installation Pterodactyl ! 🦖\n\nEnvoyez /install pour commencer l'installation complète (Panel + Wings) via Docker.");
  });

  bot.onText(/\/install/, (msg) => {
    const chatId = msg.chat.id;
    userStates.set(chatId, { step: 'WAITING_IP' });
    bot.sendMessage(chatId, "Veuillez entrer l'adresse IP de votre serveur VPS (Ubuntu 20.04/22.04 recommandé) :");
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (!text || text.startsWith('/')) return;

    const state = userStates.get(chatId);
    if (!state) return;

    switch (state.step) {
      case 'WAITING_IP':
        const ip = text.trim();
        if (!ip) {
          bot.sendMessage(chatId, "L'adresse IP ne peut pas être vide. Veuillez réessayer :");
          return;
        }
        if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip) && !/^[a-zA-Z0-9.-]+$/.test(ip)) {
          bot.sendMessage(chatId, "Format d'IP invalide. Veuillez réessayer :");
          return;
        }
        state.ip = ip;
        state.step = 'WAITING_SSH_USER';
        bot.sendMessage(chatId, "Nom d'utilisateur SSH (par défaut: root) :");
        break;

      case 'WAITING_SSH_USER':
        state.sshUsername = text.trim() || 'root';
        state.step = 'WAITING_SSH_PORT';
        bot.sendMessage(chatId, "Port SSH (par défaut: 22) :");
        break;

      case 'WAITING_SSH_PORT':
        state.sshPort = parseInt(text.trim(), 10) || 22;
        state.step = 'WAITING_AUTH_METHOD';
        bot.sendMessage(chatId, "Comment souhaitez-vous vous authentifier ?\nTapez 'mdp' pour un mot de passe, ou 'cle' pour une clé SSH privée :");
        break;

      case 'WAITING_AUTH_METHOD':
        const method = text.trim().toLowerCase();
        if (method === 'mdp' || method === 'mot de passe' || method === 'password') {
          state.step = 'WAITING_PASSWORD';
          bot.sendMessage(chatId, 'Veuillez entrer le mot de passe de votre serveur :\n*(Note: Ce mot de passe ne sera pas sauvegardé)*', { parse_mode: 'Markdown' });
        } else if (method === 'cle' || method === 'clé' || method === 'key') {
          state.step = 'WAITING_SSH_KEY';
          bot.sendMessage(chatId, 'Veuillez coller votre clé privée SSH (commençant par -----BEGIN...) :\n*(Note: Cette clé ne sera pas sauvegardée. Pensez à supprimer votre message après l\'installation par sécurité)*', { parse_mode: 'Markdown' });
        } else {
          bot.sendMessage(chatId, "Choix invalide. Tapez 'mdp' ou 'cle' :");
        }
        break;

      case 'WAITING_SSH_KEY':
        const key = text.trim();
        if (!key.includes('BEGIN')) {
          bot.sendMessage(chatId, "Cela ne ressemble pas à une clé privée valide. Veuillez réessayer :");
          return;
        }
        state.sshKey = key;
        state.step = 'WAITING_PANEL_DOMAIN';
        bot.sendMessage(chatId, "Avez-vous un nom de domaine pour le panel ?\nEnvoyez le domaine (ex: panel.domaine.com) ou tapez 'non' pour utiliser l'IP :");
        break;

      case 'WAITING_PASSWORD':
        const password = text.trim();
        if (!password) {
          bot.sendMessage(chatId, "Le mot de passe ne peut pas être vide. Veuillez réessayer :");
          return;
        }
        state.password = password;
        state.step = 'WAITING_PANEL_DOMAIN';
        bot.sendMessage(chatId, "Avez-vous un nom de domaine pour le panel ?\nEnvoyez le domaine (ex: panel.domaine.com) ou tapez 'non' pour utiliser l'IP :");
        break;

      case 'WAITING_PANEL_DOMAIN':
        const pDomain = text.trim().toLowerCase();
        state.panelDomain = (pDomain === 'non' || pDomain === 'no') ? state.ip : pDomain;
        state.step = 'WAITING_NODE_DOMAIN';
        bot.sendMessage(chatId, `Pour le Node (Wings), voulez-vous utiliser le même domaine (${state.panelDomain}) ou un autre ?\nTapez 'meme' pour utiliser le même, ou envoyez le nouveau domaine (ex: node.domaine.com) :`);
        break;

      case 'WAITING_NODE_DOMAIN':
        const nDomain = text.trim().toLowerCase();
        state.nodeDomain = (nDomain === 'meme' || nDomain === 'same') ? state.panelDomain : nDomain;
        
        // Set defaults for ports and allocations
        state.nodePort = 8080;
        state.nodeSftpPort = 2022;
        state.allocations = '3002-5002';
        
        // Generate a random secure password for the database
        state.dbPassword = Math.random().toString(36).slice(-10) + Math.random().toString(36).slice(-10) + 'A1!';
        
        state.step = 'INSTALLING';
        
        bot.sendMessage(chatId, `Démarrage de l'installation...\n\n🌐 Panel: ${state.panelDomain}\n⚙️ Node: ${state.nodeDomain}\n🔌 Allocations: ${state.allocations} (Daemon: ${state.nodePort}, SFTP: ${state.nodeSftpPort})\n\nL'installation gère tout automatiquement (Docker, Nginx, SSL Let's Encrypt). Cela peut prendre 10 à 15 minutes. Je vous tiendrai informé ! 🚀`);
        startInstallation(chatId, state, bot);
        break;
    }
  });
}

async function startInstallation(chatId: number, state: any, bot: TelegramBot) {
  const conn = new Client();
  
  conn.on('ready', () => {
    bot.sendMessage(chatId, '✅ Connexion SSH établie. Préparation du serveur...');
    
    // Actual bash commands to install Docker, Pterodactyl Panel, Wings, Nginx/Apache and SSL
    const commands = [
      { 
        msg: 'Mise à jour des paquets et installation des dépendances...',
        cmd: `export DEBIAN_FRONTEND=noninteractive; apt-get update -y && apt-get install -y curl wget git unzip tar mariadb-client jq certbot`
      },
      {
        msg: 'Installation de Docker et Docker Compose...',
        cmd: `curl -sSL https://get.docker.com/ | CHANNEL=stable bash && systemctl enable --now docker`
      },
      {
        msg: 'Préparation de Pterodactyl Panel (Docker Compose)...',
        cmd: `mkdir -p /opt/pterodactyl && cat << 'EOF' > /opt/pterodactyl/docker-compose.yml
version: '3.8'
services:
  database:
    image: mariadb:10.5
    restart: always
    command: --default-authentication-plugin=mysql_native_password
    volumes:
      - /opt/pterodactyl/database:/var/lib/mysql
    environment:
      MYSQL_ROOT_PASSWORD: ${state.dbPassword}
      MYSQL_DATABASE: panel
      MYSQL_USER: pterodactyl
      MYSQL_PASSWORD: ${state.dbPassword}
  cache:
    image: redis:alpine
    restart: always
  panel:
    image: ghcr.io/pterodactyl/panel:latest
    restart: always
    ports:
      - "${state.panelDomain === state.ip ? '80:80' : '127.0.0.1:8000:80'}"
    links:
      - database
      - cache
    volumes:
      - /opt/pterodactyl/var/:/app/var/
      - /opt/pterodactyl/nginx/:/etc/nginx/http.d/
      - /opt/pterodactyl/logs/:/app/storage/logs/
    environment:
      - DB_URL=mysql://pterodactyl:${state.dbPassword}@database:3306/panel
      - CACHE_DRIVER=redis
      - SESSION_DRIVER=redis
      - QUEUE_CONNECTION=redis
      - REDIS_HOST=cache
      - REDIS_PASSWORD=
      - REDIS_PORT=6379
      - APP_URL=${state.panelDomain === state.ip ? 'http://' + state.ip : 'https://' + state.panelDomain}
      - APP_TIMEZONE=Europe/Paris
      - APP_ENVIRONMENT_ONLY=false
EOF
cd /opt/pterodactyl && docker compose up -d database cache`
      },
      {
        msg: 'Configuration de la base de données et du Panel...',
        cmd: `cd /opt/pterodactyl && sleep 20 && docker compose run --rm panel php artisan key:generate --force && docker compose run --rm panel php artisan p:environment:setup -n --author="admin@${state.panelDomain}" --url="${state.panelDomain === state.ip ? 'http://' + state.ip : 'https://' + state.panelDomain}" --timezone="Europe/Paris" --telemetry=false && docker compose run --rm panel php artisan p:environment:database -n --host="database" --port="3306" --database="panel" --username="pterodactyl" --password="${state.dbPassword}" && docker compose run --rm panel php artisan migrate --seed --force && docker compose run --rm panel php artisan p:user:make --email="admin@${state.panelDomain}" --username="admin" --name-first="Admin" --name-last="User" --password="admin" --admin=1 && docker compose up -d panel`
      },
      {
        msg: `Configuration du serveur web (Nginx/Apache) et SSL pour ${state.panelDomain}...`,
        cmd: `if dpkg -l | grep -qw apache2; then
  echo "Apache détecté, configuration..."
  export DEBIAN_FRONTEND=noninteractive; apt-get install -y libapache2-mod-proxy-html python3-certbot-apache
  a2enmod proxy proxy_http proxy_wstunnel rewrite
  if [ "${state.panelDomain}" != "${state.ip}" ]; then
    cat << 'EOF' > /etc/apache2/sites-available/pterodactyl.conf
<VirtualHost *:80>
    ServerName ${state.panelDomain}
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:8000/
    ProxyPassReverse / http://127.0.0.1:8000/
</VirtualHost>
EOF
    a2ensite pterodactyl.conf
    if [ "${state.panelDomain}" != "${state.nodeDomain}" ] && [ "${state.nodeDomain}" != "${state.ip}" ]; then
      cat << 'EOF' > /etc/apache2/sites-available/wings.conf
<VirtualHost *:80>
    ServerName ${state.nodeDomain}
    DocumentRoot /var/www/html
</VirtualHost>
EOF
      a2ensite wings.conf
    fi
    systemctl restart apache2
    certbot --apache -d ${state.panelDomain} --non-interactive --agree-tos -m admin@${state.panelDomain} --redirect || true
    if [ "${state.panelDomain}" != "${state.nodeDomain}" ] && [ "${state.nodeDomain}" != "${state.ip}" ]; then
      certbot --apache -d ${state.nodeDomain} --non-interactive --agree-tos -m admin@${state.nodeDomain} --redirect || true
    fi
  fi
else
  echo "Nginx utilisé (ou aucun serveur web détecté), configuration..."
  export DEBIAN_FRONTEND=noninteractive; apt-get install -y nginx python3-certbot-nginx
  rm -f /etc/nginx/sites-enabled/default
  if [ "${state.panelDomain}" != "${state.ip}" ]; then
    cat << 'EOF' > /etc/nginx/sites-available/pterodactyl.conf
server {
    listen 80;
    server_name ${state.panelDomain};
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
    ln -sf /etc/nginx/sites-available/pterodactyl.conf /etc/nginx/sites-enabled/pterodactyl.conf
    
    if [ "${state.panelDomain}" != "${state.nodeDomain}" ] && [ "${state.nodeDomain}" != "${state.ip}" ]; then
      cat << 'EOF' > /etc/nginx/sites-available/wings.conf
server {
    listen 80;
    server_name ${state.nodeDomain};
    root /var/www/html;
}
EOF
      ln -sf /etc/nginx/sites-available/wings.conf /etc/nginx/sites-enabled/wings.conf
    fi
    
    systemctl restart nginx
    certbot --nginx -d ${state.panelDomain} --non-interactive --agree-tos -m admin@${state.panelDomain} --redirect || true
    if [ "${state.panelDomain}" != "${state.nodeDomain}" ] && [ "${state.nodeDomain}" != "${state.ip}" ]; then
      certbot --nginx -d ${state.nodeDomain} --non-interactive --agree-tos -m admin@${state.nodeDomain} --redirect || true
    fi
  fi
fi`
      },
      {
        msg: 'Configuration de Wings (Node) et des allocations...',
        cmd: `mkdir -p /etc/pterodactyl && cd /opt/pterodactyl && docker compose exec -T panel php artisan p:location:make --short="local" --long="Local Node" && docker compose exec -T panel php artisan p:node:make --name="LocalNode" --description="Local Node" --locationId=1 --fqdn="${state.nodeDomain}" --public=1 --scheme="${state.panelDomain === state.ip ? 'http' : 'https'}" --proxy=0 --maintain=0 --memory=10240 --memoryOverallocate=0 --disk=102400 --diskOverallocate=0 --uploadSize=100 --daemonBase="/var/lib/pterodactyl/volumes" --daemonPort=${state.nodePort} --daemonSFTPPort=${state.nodeSftpPort} && docker compose exec -T panel php artisan tinker --execute="for (\\$i = 3002; \\$i <= 5002; \\$i++) { DB::table('allocations')->insert(['node_id' => 1, 'ip' => '${state.ip}', 'port' => \\$i, 'created_at' => now(), 'updated_at' => now()]); }" && docker compose exec -T panel php artisan p:node:configuration 1 > /etc/pterodactyl/config.yml`
      },
      {
        msg: 'Démarrage de Wings via Docker...',
        cmd: `cat << 'EOF' > /opt/pterodactyl/docker-compose-wings.yml
version: '3.8'
services:
  wings:
    image: ghcr.io/pterodactyl/wings:latest
    restart: always
    network_mode: "host"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/lib/docker/containers/:/var/lib/docker/containers/
      - /etc/pterodactyl/:/etc/pterodactyl/
      - /var/lib/pterodactyl/:/var/lib/pterodactyl/
      - /var/log/pterodactyl/:/var/log/pterodactyl/
      - /tmp/pterodactyl/:/tmp/pterodactyl/
      - /etc/letsencrypt/:/etc/letsencrypt/
EOF
cd /opt/pterodactyl && docker compose -f docker-compose-wings.yml up -d`
      }
    ];

    let currentCmd = 0;

    const executeNext = () => {
      if (currentCmd >= commands.length) {
        conn.end();
        
        const successMsg = `🎉 **Installation terminée avec succès !**

🌐 **Panel URL:** http${state.panelDomain !== state.ip ? 's' : ''}://${state.panelDomain}
⚙️ **Node URL:** ${state.nodeDomain}
🖥️ **IP Serveur:** \`${state.ip}\`

👤 **Accès Admin (Panel):**
- Username: \`admin\`
- Password: \`admin\`
⚠️ *À changer immédiatement après la première connexion !*

🗄️ **Base de données (MariaDB):**
- Database: \`panel\`
- User: \`pterodactyl\`
- Password: \`${state.dbPassword}\`

🔌 **Configuration Node (Wings):**
- Daemon Port: \`${state.nodePort}\`
- SFTP Port: \`${state.nodeSftpPort}\`
- Allocations: \`${state.allocations}\`

Profitez de votre panel Pterodactyl ! 🚀`;

        bot.sendMessage(chatId, successMsg, { parse_mode: 'Markdown' });
        userStates.delete(chatId);
        return;
      }

      const step = commands[currentCmd];
      bot.sendMessage(chatId, `⏳ ${step.msg}`);

      conn.exec(step.cmd, (err, stream) => {
        if (err) {
          bot.sendMessage(chatId, `❌ Erreur lors de: ${step.msg}\n${err.message}`);
          conn.end();
          return;
        }
        stream.on('close', (code: any, signal: any) => {
          if (code !== 0) {
            bot.sendMessage(chatId, `⚠️ *Attention* lors de: ${step.msg}\nLe code de retour est \`${code}\`. L'installation continue mais vérifiez les logs si un problème survient.`, { parse_mode: 'Markdown' });
          }
          currentCmd++;
          executeNext();
        }).on('data', (data: any) => {
          // console.log('STDOUT: ' + data);
        }).stderr.on('data', (data: any) => {
          // console.log('STDERR: ' + data);
        });
      });
    };

    executeNext();

  }).on('error', (err: any) => {
    let errorMsg = err.message;
    if (err.level === 'client-authentication') {
      errorMsg = "Échec de l'authentification. Le mot de passe ou le nom d'utilisateur est incorrect.";
    } else if (err.code === 'ECONNREFUSED') {
      errorMsg = "Connexion refusée. Vérifiez que le port SSH est ouvert et correct.";
    } else if (err.code === 'ETIMEDOUT') {
      errorMsg = "Délai d'attente dépassé. L'adresse IP est peut-être incorrecte ou le serveur est hors ligne.";
    }
    bot.sendMessage(chatId, `❌ Impossible de se connecter au serveur via SSH.\nErreur: ${errorMsg}`);
    userStates.delete(chatId);
  });
  
  const sshConfig: any = {
    host: state.ip,
    port: state.sshPort || 22,
    username: state.sshUsername || 'root',
    readyTimeout: 10000
  };
  
  if (state.sshKey) {
    sshConfig.privateKey = state.sshKey;
  } else {
    sshConfig.password = state.password;
  }
  
  conn.connect(sshConfig);
}
