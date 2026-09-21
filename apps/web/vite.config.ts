import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const target=process.env.API_PROXY_TARGET??'http://localhost:3100';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),plugins:[react()],server:{host:'0.0.0.0',port:5173,proxy:{'/api':target,'/media':target,'/health':target}},build:{outDir:'../../dist/web',emptyOutDir:true}});
