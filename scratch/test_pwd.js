const bcrypt = require('bcryptjs');

async function test() {
  const hash1 = '$2a$12$A5USP5NegnDsk77VXVU3i.bysTaRkAXWmj8ctTJbjeFEcn9/HrXkq';
  const hash2 = '$2a$12$y/BnAjOTMSG7dNBRVnfEXea08oYtl5kFxXjxor4qRfqqL0Nd3qP/a';
  
  console.log('Local DB hash match for HomeGenny@2024:', await bcrypt.compare('HomeGenny@2024', hash1));
  console.log('SQL seed hash match for HomeGenny@2024:', await bcrypt.compare('HomeGenny@2024', hash2));
}

test();
