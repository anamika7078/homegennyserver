const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const modules = [
  'finance',
  'finance/payroll',
  'finance/invoice',
  'finance/settlement',
  'finance/esic',
  'finance/pf',
  'finance/deposit',
  'finance/analytics'
];

modules.forEach(mod => {
  console.log(`Generating module ${mod}...`);
  try {
    execSync(`npx nest generate module modules/${mod} --no-spec`, { stdio: 'inherit' });
    execSync(`npx nest generate controller modules/${mod} --no-spec`, { stdio: 'inherit' });
    execSync(`npx nest generate service modules/${mod} --no-spec`, { stdio: 'inherit' });
  } catch (err) {
    console.error(`Failed to generate ${mod}`, err.message);
  }
});
