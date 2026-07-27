const axios = require('axios');

async function testLogin() {
  const url = 'https://homegennyserver-po5u.onrender.com/api/v1/auth/login';
  const payload = {
    phone: '9800000001',
    password: 'HomeGenny@2024'
  };
  
  try {
    console.log('Sending login request to', url, 'with', payload);
    const res = await axios.post(url, payload);
    console.log('Success response:', res.status, JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error('Error response:', err.response?.status, err.response?.data || err.message);
  }
}

testLogin();
