try {
    process.loadEnvFile();
} catch {
    /* no .env file; the real environment wins */
}
