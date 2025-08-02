console.log('process.argv:', process.argv);
const indexOfElectrobun = process.argv.findIndex((arg) => arg.includes('electrobun'));
console.log('indexOfElectrobun:', indexOfElectrobun);
const commandArg = process.argv[indexOfElectrobun + 1] || 'build';
console.log('commandArg:', commandArg);
