# gh-ci-compact

Compact GitHub Actions jobs into parallel, machine-readable CI.

## Goal

Convert multiple short GitHub Actions jobs into one parallel job while
preserving logical task boundaries and emitting structured diagnostics.

## Install

    gh extension install OWNER/gh-ci-compact

## Usage

    gh ci-compact analyze
    gh ci-compact analyze --json
    gh ci-compact compile

## Development

Requires Node.js 22+.

    npm install
    npm run check

Install the current checkout as a GitHub CLI extension:

    gh extension install .

Then:

    gh ci-compact analyze
