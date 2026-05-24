/* eslint-disable no-console */
// Interactive helper: hash a password for ADMIN_PASSWORD_HASH.
// Usage:  npm run hash-password
import bcrypt from 'bcryptjs';
import readline from 'node:readline';

function prompt(question: string, silent = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (silent) {
      // Mute echo
      const stdin = process.stdin as NodeJS.ReadStream & { _writeToOutput?: unknown };
      const original = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (s: string) {
        if (s.includes(question)) original.call(this as unknown as { _writeToOutput: (s: string) => void }, s);
        else original.call(this as unknown as { _writeToOutput: (s: string) => void }, '*');
      };
      void stdin;
    }
    rl.question(question, (ans) => {
      rl.close();
      console.log('');
      resolve(ans);
    });
  });
}

async function main() {
  const pwd = await prompt('Password to hash (will be hidden): ', true);
  if (pwd.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const hash = await bcrypt.hash(pwd, 12);
  console.log('\nCopy this into apps/backend/.env as ADMIN_PASSWORD_HASH:\n');
  console.log(hash);
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
