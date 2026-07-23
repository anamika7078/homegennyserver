const axios = require('axios');

async function main() {
  try {
    const res = await axios.post('http://localhost:3000/api/v1/training/batches', {
      series: 'DR',
      start_date: '2026-07-23'
    }, {
      headers: {
        Authorization: 'Bearer YOUR_TOKEN_HERE' // I need a token, or I can just use the service directly.
      }
    });
  } catch (err) {
    console.log(err.message);
  }
}
main();
