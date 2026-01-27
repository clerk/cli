BINARY  := clerk
PKG     := ./cmd/clerk
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X clerk.com/cli/internal/cmd.Version=$(VERSION)

.PHONY: build install clean fmt vet test lint tidy run

build:
	go build -ldflags "$(LDFLAGS)" -o $(BINARY) $(PKG)

install:
	go install -ldflags "$(LDFLAGS)" $(PKG)

run:
	go run $(PKG) $(ARGS)

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -s -w .

lint: vet
	@which golangci-lint >/dev/null 2>&1 || { echo "golangci-lint not installed"; exit 1; }
	golangci-lint run

tidy:
	go mod tidy

clean:
	rm -f $(BINARY)
