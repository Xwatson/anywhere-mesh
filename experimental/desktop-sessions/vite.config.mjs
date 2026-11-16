import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('./ui',import.meta.url)),base:'./',plugins:[react(),tailwindcss()],build:{outDir:'../dist',emptyOutDir:true,sourcemap:false}});
