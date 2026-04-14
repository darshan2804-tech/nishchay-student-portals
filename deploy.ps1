# Nishchay Academy - Deployment Script

Write-Host "Starting Deployment Pipeline for Student Portal..." -ForegroundColor Cyan

# 1. Initialize Git and Stage changes
Write-Host "Initializing Git..." -ForegroundColor Yellow
if (-Not (Test-Path ".git")) {
    C:\Users\komal\Downloads\MinGit\cmd\git.exe init
}

C:\Users\komal\Downloads\MinGit\cmd\git.exe add .
C:\Users\komal\Downloads\MinGit\cmd\git.exe commit -m "feat: Systemic Overhaul - Vercel & Firebase Migrations"

Write-Host "Git commit created. (You need to 'git remote add origin <URL>' before pushing)" -ForegroundColor Magenta

# 2. Vercel Deployment
Write-Host "Deploying to Vercel..." -ForegroundColor Yellow
# Requires Vercel CLI to be installed (npm i -g vercel)
try {
    vercel --prod
    Write-Host "Vercel Deployment Triggered!" -ForegroundColor Green
} catch {
    Write-Host "Vercel CLI not found or login required. Install using 'npm i -g vercel' and authenticate." -ForegroundColor Red
}

Write-Host "Deployment script finished." -ForegroundColor Cyan
