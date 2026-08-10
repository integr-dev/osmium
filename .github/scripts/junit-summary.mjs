#!/usr/bin/env node
/**
 * Turns JUnit XML into a GitHub Actions job summary plus one annotation per failing test.
 *
 * Reporting only — it never fails the job. The test step already does that, and a reporter that can
 * fail would hide the real cause behind its own error.
 *
 *   node junit-summary.mjs "Backend tests" build/test-results/test
 *
 * Each path is a directory searched for *.xml, or an XML file. Node rather than Python so the same
 * script runs on the runner and on a developer machine without another toolchain.
 */

import { readdirSync, readFileSync, statSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_DETAIL_CHARS = 1200
const MAX_ANNOTATIONS = 20

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)]]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (whole, name) => ENTITIES[name] ?? whole)
}

function attribute(tag, name) {
  const found = tag.match(new RegExp(`\\s${name}="([^"]*)"`))
  return found ? decode(found[1]) : ''
}

function xmlFiles(paths) {
  const found = []
  for (const path of paths) {
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      found.push(...readdirSync(path).filter((f) => f.endsWith('.xml')).map((f) => join(path, f)))
    } else if (path.endsWith('.xml')) {
      found.push(path)
    }
  }
  return found.sort()
}

/** `<testcase .../>` or `<testcase ...>…</testcase>`, capturing the open tag and any body. */
const TESTCASE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
const PROBLEM = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/

function collect(files) {
  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 }
  const failures = []
  let seconds = 0

  for (const file of files) {
    const xml = readFileSync(file, 'utf8')
    for (const [, openTag, , body = ''] of xml.matchAll(TESTCASE)) {
      totals.tests += 1
      seconds += Number(attribute(openTag, 'time')) || 0

      if (/<skipped\b/.test(body)) {
        totals.skipped += 1
        continue
      }

      const problem = body.match(PROBLEM)
      if (!problem) continue

      const [, kind, problemTag, detail = ''] = problem
      totals[kind === 'failure' ? 'failures' : 'errors'] += 1
      failures.push({
        classname: attribute(openTag, 'classname'),
        name: attribute(openTag, 'name') || '(unnamed)',
        message: attribute(problemTag, 'message') || attribute(problemTag, 'type'),
        detail: decode(detail).trim().slice(0, MAX_DETAIL_CHARS),
      })
    }
  }

  return { totals, failures, seconds }
}

function render(label, { totals, failures, seconds }) {
  if (totals.tests === 0) {
    return `## ${label}\n\nNo test results were produced — the run stopped before the tests.\n`
  }

  const bad = totals.failures + totals.errors
  const lines = [
    `## ${label} — ${bad === 0 ? 'all green' : `**${bad} failing**`}`,
    '',
    '| Tests | Failures | Errors | Skipped | Time |',
    '|---:|---:|---:|---:|---:|',
    `| ${totals.tests} | ${totals.failures} | ${totals.errors} | ${totals.skipped} | ${seconds.toFixed(1)}s |`,
    '',
  ]

  for (const failure of failures) {
    lines.push(
      `### \`${[failure.classname, failure.name].filter(Boolean).join(' › ')}\``,
      '',
      failure.message,
      '',
      '```',
      failure.detail || '(no detail reported)',
      '```',
      '',
    )
  }

  return lines.join('\n')
}

function annotate(failures) {
  for (const failure of failures.slice(0, MAX_ANNOTATIONS)) {
    const title = [failure.classname, failure.name].filter(Boolean).join(' › ')
    // Annotations are single-line; %0A is how Actions encodes a newline within one.
    const body = (failure.message || failure.detail || 'test failed')
      .replaceAll('%', '%25')
      .replaceAll('\r', '')
      .replaceAll('\n', '%0A')
    console.log(`::error title=${title}::${body}`)
  }

  if (failures.length > MAX_ANNOTATIONS) {
    console.log(`::notice::${failures.length - MAX_ANNOTATIONS} further failures are in the summary`)
  }
}

const [label, ...paths] = process.argv.slice(2)
if (!label || paths.length === 0) {
  console.error('usage: junit-summary.mjs <label> <xml file or directory>...')
  process.exit(2)
}

const result = collect(xmlFiles(paths))
const summary = render(label, result)
annotate(result.failures)

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, 'utf8')
} else {
  console.log(summary)
}
