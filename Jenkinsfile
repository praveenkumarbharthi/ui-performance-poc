// Declarative pipeline for a WINDOWS Jenkins agent (bat steps).
//
// Reliability rules:
//  - Evidence is always published: the UI journey, report aggregation and report
//    validation use catchError so a failure does not skip later stages or the
//    post-always JUnit/archive steps.
//  - Quality gates reflect the result: functional failures and enforced threshold
//    breaches set the build to FAILURE; a non-critical Lighthouse failure OR a
//    partial/incomplete audit (which still exits 0) sets it to UNSTABLE instead of
//    silently passing.
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
    PERF_THRESHOLDS_ENABLED = "${env.PERF_THRESHOLDS_ENABLED ?: 'true'}"
    // Strict thresholds: an enforced threshold whose metric is unavailable fails the gate.
    THRESHOLDS_STRICT       = "${env.THRESHOLDS_STRICT ?: 'false'}"
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
        // Chrome is optional: the audit prefers a system Chrome, then falls back to
        // Playwright's bundled Chromium (installed by the step above).
        bat 'if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (echo Chrome: found) else (echo Chrome: NOT found - Lighthouse will use Playwright-bundled Chromium)'
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
        // Lighthouse is network/Chrome dependent, so it marks the build UNSTABLE
        // rather than FAILURE and keeps the UI journey result valid. A *partial*
        // audit (some pages failed or were skipped) still exits 0, so the exit code
        // alone is not enough - the audit's own summary status is inspected too,
        // otherwise incomplete results would produce a green (SUCCESS) build.
        script {
          def lhExit = bat(returnStatus: true, script: 'call npm run lighthouse')
          def lhStatus = bat(
            returnStdout: true,
            script: '''node -e "const fs=require('fs');const f='reports/lighthouse/summary.json';process.stdout.write(fs.existsSync(f)?(JSON.parse(fs.readFileSync(f,'utf8')).status||'unknown'):'missing')"'''
          ).trim()
          echo "Lighthouse: exit=${lhExit}, audit status=${lhStatus}"
          if (lhStatus == 'unstable') {
            unstable('Lighthouse audit only partially completed (some pages failed or were skipped); results are incomplete, not a full pass. See reports/lighthouse/summary.json.')
          } else if (lhStatus == 'failed' || lhStatus == 'missing' || lhStatus == 'unknown' || lhExit != 0) {
            unstable('Lighthouse audit did not complete cleanly (status=' + lhStatus + ', exit=' + lhExit + '); UI journey results are still valid. See reports/lighthouse/summary.json.')
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
