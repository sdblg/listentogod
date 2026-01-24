.PHONY: help backend-build backend-run backend-clean frontend-install frontend-dev frontend-build frontend-clean clean all

help: ## Show this help message
	@echo "ListenToGod - Makefile Commands"
	@echo ""
	@echo "Backend (Go):"
	@grep -E '^  backend-' $(MAKEFILE_LIST) | sed 's/:.*##/: /' | sed 's/^  /  make /'
	@echo ""
	@echo "Frontend (React):"
	@grep -E '^  frontend-' $(MAKEFILE_LIST) | sed 's/:.*##/: /' | sed 's/^  /  make /'
	@echo ""
	@echo "Utility:"
	@grep -E '^  (clean|all)' $(MAKEFILE_LIST) | sed 's/:.*##/: /' | sed 's/^  /  make /'

backend-build: ## Build backend binary
	cd backend && go build -o bin/server ./cmd/app/main.go

backend-run: ## Run backend server
	cd backend && go run ./cmd/app/main.go

backend-clean: ## Clean backend build artifacts
	cd backend && rm -rf bin/

frontend-install: ## Install frontend dependencies
	cd frontend && npm install

frontend-dev: frontend-install ## Start frontend dev server (port 5173)
	cd frontend && npm run dev

frontend-build: frontend-install ## Build frontend for production
	cd frontend && npm run build

frontend-clean: ## Clean frontend node_modules and build
	cd frontend && rm -rf node_modules dist

clean: backend-clean frontend-clean ## Clean all build artifacts

all: frontend-build backend-build ## Build both frontend and backend
