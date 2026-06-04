const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function requireEnv(name, fallback) {
  const value = process.env[name] || fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

module.exports = {
  port: Number(process.env.PORT || 3020),
  sessionSecret: requireEnv('SESSION_SECRET'),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    database: requireEnv('DB_NAME'),
    charset: 'utf8mb4'
  },
  initialAdmin: {
    username: process.env.INITIAL_ADMIN_USERNAME || '吴逸翔',
    password: requireEnv('INITIAL_ADMIN_PASSWORD')
  }
};
