BINARY  := clerk
PKG     := ./cmd/clerk
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X clerk.com/cli/internal/cmd.Version=$(VERSION)

.PHONY: build install clean fmt vet test lint tidy run check security setup-hooks

# Build targets
build:
	go build -ldflags "$(LDFLAGS)" -o $(BINARY) $(PKG)

install:
	go install -ldflags "$(LDFLAGS)" $(PKG)

run:
	go run $(PKG) $(ARGS)

clean:
	rm -f $(BINARY)
	rm -f coverage.out

# Test targets
test:
	go test -race ./...

test-coverage:
	go test -race -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"

# Code quality targets
fmt:
	gofmt -s -w .
	goimports -w -local clerk.com/cli .

vet:
	go vet ./...

lint:
	@which golangci-lint >/dev/null 2>&1 || { echo "Installing golangci-lint..."; go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest; }
	golangci-lint run --timeout=5m

lint-fix:
	@which golangci-lint >/dev/null 2>&1 || { echo "Installing golangci-lint..."; go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest; }
	golangci-lint run --fix --timeout=5m

# Security targets
security:
	@which gosec >/dev/null 2>&1 || { echo "Installing gosec..."; go install github.com/securego/gosec/v2/cmd/gosec@latest; }
	gosec -exclude-generated -severity medium -confidence medium ./...

vulncheck:
	@which govulncheck >/dev/null 2>&1 || { echo "Installing govulncheck..."; go install golang.org/x/vuln/cmd/govulncheck@latest; }
	govulncheck ./...

# Combined checks (run before pushing)
check: fmt vet lint test
	@echo "✓ All checks passed!"

check-all: fmt vet lint security vulncheck test
	@echo "✓ All checks (including security) passed!"

# Dependency management
tidy:
	go mod tidy

deps:
	go mod download

# Setup development environment
setup:
	go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	go install github.com/securego/gosec/v2/cmd/gosec@latest
	go install golang.org/x/vuln/cmd/govulncheck@latest
	go install golang.org/x/tools/cmd/goimports@latest
	@echo "✓ Development tools installed"

setup-hooks:
	@cp scripts/pre-commit .git/hooks/pre-commit
	@chmod +x .git/hooks/pre-commit
	@echo "✓ Git hooks installed"

# Help
help:
	@echo "Available targets:"
	@echo "  build        - Build the binary"
	@echo "  install      - Install to GOPATH/bin"
	@echo "  run          - Run with ARGS='...'"
	@echo "  test         - Run tests with race detection"
	@echo "  test-coverage - Run tests with coverage report"
	@echo "  fmt          - Format code"
	@echo "  vet          - Run go vet"
	@echo "  lint         - Run golangci-lint"
	@echo "  lint-fix     - Run golangci-lint with auto-fix"
	@echo "  security     - Run gosec security scanner"
	@echo "  vulncheck    - Check for known vulnerabilities"
	@echo "  check        - Run fmt, vet, lint, test (pre-push)"
	@echo "  check-all    - Run all checks including security"
	@echo "  tidy         - Run go mod tidy"
	@echo "  setup        - Install development tools"
	@echo "  setup-hooks  - Install git pre-commit hook"
	@echo "  clean        - Remove build artifacts"
