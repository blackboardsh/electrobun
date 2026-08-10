const provenance = {
	cottontail: process.versions.cottontail ?? null,
	execPath: process.execPath,
};

console.log(`ELECTROBUN_RUNTIME_PROVENANCE=${JSON.stringify(provenance)}`);
