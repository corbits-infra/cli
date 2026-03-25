export PATH			:=		$(PWD)/bin:$(PATH)
export INSIDE_STAGING_DIR	:=		false

all: lint build

pre-build: FORCE
	rm -f .eslintcache .build-finished

build: pre-build FORCE
	rm -rf dist
	pnpm tsc
	touch .build-finished

lint:
	pnpm prettier -c .
	pnpm eslint --cache .

format:
	pnpm prettier -w .

clean:
	rm -f .eslintcache .build-finished
	rm -rf dist

.PHONY: all lint
FORCE:
