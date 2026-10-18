// Declarative pipeline for a WINDOWS Jenkins agent (bat steps).
//
// Reliability rules:
//  - Evidence is always published: the UI journey, report aggregation and report
//    validation use catchError so a failure does not skip later stages or the
//    post-always JUnit/archive steps.
//  - Quality gates reflect the result: functional failures and enforced threshold
//    breaches set the build to FAILURE; a non-critical Lighthouse failure sets it
//    to UNSTABLE instead of silently passing.
pipeline {
  agent { label 'windows' }

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  environment {
    BASE_URL                = "${env.BASE_URL ?: 'https://www.saucedemo.com'}"
    SAUCE_USERNAME          = "${env.SAUCE_USERNAME ?: 'standard_user'}"
    SAUCE_PASSWORD          = "${env.SAUCE_PASSWORD ?: 'secret_sauce'}"
    PLAYWRIGHT_BROWSER      = 'chromium'
    PERF_THRESHOLDS_ENABLED = "${env.PERF_THRESHOLDS_ENABLED ?: 'false'}"
    // Unique run id so raw artifacts never overwrite previous evidence.
    RUN_ID                  = "${env.BUILD_TAG ?: 'jenkins'}-${env.BUILD_NUMBER ?: '0'}"
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Mark run start') {
      steps {
        // Written to a file so report aggregation can reject stale artifacts even
        // though it runs in a separate process.
        bat 'if not exist reports mkdir reports'
        bat 'powershell -NoProfile -Command "(Get-Date).ToUniversalTime().ToString(\'yyyy-MM-ddTHH:mm:ss.fffZ\') | Set-Content -NoNewline reports\\run-started-at.txt"'
        bat 'type reports\\run-started-at.txt'
      }
    }

    stage('Tool checks') {
      steps {
        bat 'node -v'
        bat 'npm -v'
        // Fails the stage if the Node/npm toolchain does not meet requirements.
        bat 'node scripts/check-env.js --tools-only'
        // Chrome is optional: chrome-launcher auto-detects it, else bundled Chromium is used.
        bat 'if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" (echo Chrome: found) else (echo Chrome: NOT found - Lighthouse will rely on bundled Chromium)'
      }
    }

    stage('Install dependencies') {
      steps {
        bat 'if exist package-lock.json (call npm ci) else (call npm install)'
      }
    }

    stage('Environment validation') {
      steps {
        bat 'call npm run check:env'
      }
    }

    stage('Unit tests') {
      steps {
        // Fails the build on a broken calculation/report rule but keeps going so
        // later stages (and post-always publishing) still run.
        catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
          bat 'call npm run test:unit'
        }
      }
    }

    stage('Dependency security audit') {
      steps {
        // Non-zero exit on HIGH or CRITICAL advisories; moderate/low are reported only.
        bat 'call npm audit --audit-level=high'
      }
    }

    stage('Install Playwright Chromium') {
      steps {
        bat 'call npx playwright install chromium'
      }
    }

    stage('UI journey (Playwright)') {
      steps {
        // A functional failure fails the build but must not skip report publishing.
        catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
          bat 'call npm run test:ui'
        }
      }
    }

    stage('Lighthouse audit') {
      steps {
        // Lighthouse is network/Chrome dependent: record the failure and keep the
        // UI journey result valid by marking the build unstable instead of failed.
        script {
          def lhStatus = bat(returnStatus: true, script: 'call npm run lighthouse')
          if (lhStatus != 0) {
            echo "WARNING: Lighthouse audit failed (exit ${lhStatus}). See reports/lighthouse/summary.json."
            unstable('Lighthouse audit failed; UI journey results are still valid.')
          }
        }
      }
    }

    stage('Report aggregation') {
      steps {
        // Exits non-zero on a functional or enforced threshold failure.
        catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
          bat 'call npm run report'
        }
      }
    }

    stage('Validate reports') {
      steps {
        catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
          bat 'call npm run validate:reports'
        }
      }
    }
  }

  post {
    always {
      // Publish results even when an earlier stage failed.
      junit allowEmptyResults: true, testResults: 'reports/junit/*.xml'

      archiveArtifacts allowEmptyArchive: true, artifacts: 'reports/**/*.html, reports/**/*.json, reports/**/*.md, reports/**/*.xml, reports/**/*.png, reports/**/*.zip', fingerprints: false

      echo 'Reports archived under reports/ (dashboard.html, HTML, JSON, Markdown, JUnit XML, screenshots, traces).'
    }
    success {
      echo 'Build succeeded: UI journey passed and reports were generated.'
    }
    unstable {
      echo 'Build unstable: a non-critical stage (e.g. Lighthouse) failed or results are incomplete. Review archived reports.'
    }
    failure {
      echo 'Build failed: inspect the UI journey, threshold breaches, report generation, or validation stage logs.'
    }
    cleanup {
      // Remove bulky transient Playwright output; keep reports/ evidence intact.
      bat 'if exist test-results rmdir /S /Q test-results'
      bat 'if exist playwright-report rmdir /S /Q playwright-report'
      deleteDir()
    }
  }
}
