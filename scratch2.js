const axios = require('axios');
axios.post('http://localhost:3001/api/v1/assessments/create', { candidate_id: 'ST-DR-001', assessment_type: 'DRIVER', series: 'DR' })
  .then(res => console.log('SUCCESS:', res.data))
  .catch(err => console.error('ERROR:', err.response ? err.response.data : err.message));
