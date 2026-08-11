const http = require('http');

const data = JSON.stringify({
  phone: '9800000003',
  password: 'HomeGenny@2024'
});

const req = http.request('http://localhost:3001/api/v1/auth/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
}, (res) => {
  console.log('STATUS:', res.statusCode);
  console.log('HEADERS:', res.headers);
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => console.log('BODY:', body));
});

req.on('error', (e) => {
  console.error('REQUEST ERROR:', e.message);
});

req.write(data);
req.end();
