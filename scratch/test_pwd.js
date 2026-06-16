const bcrypt = require('bcryptjs');

async function test() {
  const hash = '$2a$12$jMmp6LF3CbjVAi.FCWYlFOH9IwQJcFtl3jeqQSOuXvTDJCmLe6G3e';
  const match = await bcrypt.compare('HomeGenny@2024', hash);
  console.log({ 'HomeGenny@2024': match });
}

test();
