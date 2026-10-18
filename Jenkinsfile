// -----------------------------------------------------------------------------
// Jenkinsfile - declarative pipeline for a WINDOWS Jenkins agent (bat steps).
//
// Stages: checkout -> tool checks -> npm ci -> dependency audit -> Playwright
//         Chromium -> UI journey -> Lighthouse -> report aggregation
//         -> validation -> publish.
//
// Design rules:
//   - No hard-coded Jenkins workspace or machine-specific tool paths.
//   - Failures propagate; nothing is swallowed to make the build green.
//   - Public SauceDemo credentials only; no secrets in code or logs.
//   - Reports are archived with safe handling for possibly-empty archives.
// -----------------------------------------------------------------------------

pipeline {
  agent { label 'windows' }

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  environment {
    // Configurable via job parameters / Jenkins credentials as needed.
    BASE_URL              = "${env.BASE_URL ?: 'https://www.saucedemo.com'}"
    SAUCE_USERNAME        = "${env.SAUCE_USERNAME ?: 'standard_user'}"
    SAUCE_PASSWORD        = "${env.SAUCE_PASSWORD ?: 'secret_sauce'}"
    PLAYWRIGHT_BROWSER    = 'chromium'
    PERF_THRESHOLDS_ENABLED = "${env.PERF_THRESHOLDS_ENABLED ?: 'false'}"
    // Unique run id so raw artifacts never overwrite previous evidence.
    RUN_ID                = "${env.BUILD_TAG ?: 'jenkins'}-${env.BUILD_NUMBER ?: '0'}"
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
        echo "Checking out revision for build ${env.BUILD_NUMBER}"
      }
    }

    stage('Tool checks') {
      steps {
        bat 'node -v'
        bat 'npm -v'
        // Chrome is optional here: chrome-launcher auto-detects it. Log if present.
        bat 'if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" (echo Chrome: found) else (echo Chrome: NOT found - Lighthouse will rely on bundled Chromium)'
      }
    }

    stage('Install dependencies') {
      steps {
        // Use the lock file when present for reproducible installs.
        bat 'if exist package-lock.json (call npm ci) else (call npm install)'
      }
    }

    stage('Dependency security audit') {
      steps {
        // Fail the build on HIGH or CRITICAL advisories; moderate/low are
        // reported but do not break the build. Exit code is non-zero on HIGH+.
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
        // Lighthouse is network/Chrome dependent. Allow the build to continue so
        // the report stage can record the failure explicitly, then we re-check.
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
      // Publish JUnit results for the Jenkins test trend (tolerate empty).
      junit allowEmptyResults: true, testResults: 'reports/junit/*.xml'

      // Archive evidence with safe handling for missing/empty archives.
      archiveArtifacts allowEmptyArchive: true, artifacts: 'reports/**/*.html, reports/**/*.json, reports/**/*.md, reports/**/*.xml, reports/**/*.png, reports/**/*.zip, fingerprints: false

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
