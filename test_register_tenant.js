const axios = require('axios');
(async ()=>{
  try{
    const login = await axios.post('https://redbackend.fly.dev/api/auth/login', { email: 'testuser+ai@example.com', password: 'secret123' });
    const token = login.data.data.access_token;
    console.log('token len', token ? token.length : 0);
    const r = await axios.post('http://127.0.0.1:7860/api/auth/register-tenant', { tenant: { nome: 'Local Tenant X', tipo: 'restaurante' } }, { headers: { Authorization: 'Bearer ' + token } });
    console.log('local register-tenant OK', r.data);
  } catch (e) {
    console.error('ERR', e.response ? e.response.status : e.message, e.response ? e.response.data : '');
    process.exit(1);
  }
})();
