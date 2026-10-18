// Declarative pipeline for a WINDOWS Jenkins agent (bat steps).
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

    stage('Tool checks') {
      steps {
        bat 'node -v'
        bat 'npm -v'
        // Chrome is optional: chrome-launcher auto-detects it, else bundled Chromium is used.
        bat 'if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" (echo Chrome: found) else (echo Chrome: NOT found - Lighthouse will rely on bundled Chromium)'
      }
    }

    stage('Install dependencies') {
      steps {
        bat 'if exist package-lock.json (call npm ci) else (call npm install)'
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
        bat 'call npm run test:ui'
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
        bat 'call npm run report'
      }
    }

    stage('Validate reports') {
      steps {
        bat 'call npm run validate:reports'
      }
    }
  }

  post {
    always {
      junit allowEmptyResults: true, testResults: 'reports/junit/*.xml'

      archiveArtifacts allowEmptyArchive: true, artifacts: 'reports/**/*.html, reports/**/*.json, reports/**/*.md, reports/**/*.xml, reports/**/*.png, reports/**/*.zip', fingerprints: false

      echo 'Reports archived under reports/ (HTML, JSON, Markdown, JUnit XML, screenshots, traces).'
    }
    success {
      echo 'Build succeeded: UI journey passed and reports were generated.'
    }
    unstable {
      echo 'Build unstable: a non-critical stage (e.g. Lighthouse) failed. Review archived reports.'
    }
    failure {
      echo 'Build failed: inspect the UI journey, report generation, or validation stage logs.'
    }
    cleanup {
      // Remove bulky transient Playwright output; keep reports/ evidence intact.
      bat 'if exist test-results rmdir /S /Q test-results'
      bat 'if exist playwright-report rmdir /S /Q playwright-report'
      deleteDir()
    }
  }
}
