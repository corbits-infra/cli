export PATH			:=		$(PWD)/bin:$(PATH)
export INSIDE_STAGING_DIR	:=		false

all: build lint test

pre-build: FORCE
	rm -f .eslintcache .build-finished

build: pre-build FORCE
	rm -rf dist tsconfig.tsbuildinfo
	pnpm tsc
	pnpm tsc -p tests/tsconfig.json --noEmit
	touch .build-finished

lint:
	pnpm prettier -c .
	pnpm eslint --cache .

format:
	pnpm prettier -w .

test:
	@[[ -d .tap/plugins ]] || pnpm tap build
	pnpm tap --disable-coverage

clean:
	rm -f .eslintcache .build-finished tsconfig.tsbuildinfo
	rm -rf dist .tap

.PHONY: all lint test
FORCE:
