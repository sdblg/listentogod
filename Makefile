.PHONY: help backend-build backend-run backend-clean frontend-install frontend-dev frontend-build frontend-clean run run-all clean all-build all-run all-restart all-stop kill-port

help: ## Show this help message
	@echo "ListenToGod - Makefile Commands"
	@echo ""
	@echo "Backend (Go):"
	@grep -E '^backend-' $(MAKEFILE_LIST) | sed 's/:.*## /: /' | sed 's/^/  make /'
	@echo ""
	@echo "Frontend (React):"
	@grep -E '^frontend-' $(MAKEFILE_LIST) | sed 's/:.*## /: /' | sed 's/^/  make /'
	@echo ""
	@echo "Utility:"
	@grep -E '^(clean|all):' $(MAKEFILE_LIST) | sed 's/:.*## /: /' | sed 's/^/  make /'

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

all-build: backend-build frontend-build ## Build both backend and frontend

all-run: ## Run backend and frontend (in parallel)
	@echo "Starting backend and frontend..."
	@echo ""
	@IP=$$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $$2}' | head -1); \
	echo "Backend:  http://localhost:8080  or  http://$$IP:8080"; \
	echo "Frontend: http://localhost:5173 or  http://$$IP:5173"; \
	echo ""; \
	echo "Press Ctrl+C to stop"; \
	echo ""
	cd backend && go run ./cmd/app/main.go & \
	cd frontend && npm run dev

all-restart: ## Restart backend and frontend (kill and run)
	@pkill -f "go run ./cmd/app/main.go" || true
	@pkill -f "npm run dev" || true
	@sleep 1
	@$(MAKE) all-run

all-stop: ## Stop backend and frontend
	@pkill -f "go run ./cmd/app/main.go" || true
	@pkill -f "npm run dev" || true
	@echo "Stopped all processes"

kill-port: ## Kill processes on ports 8080 (backend) and 5173 (frontend)
	@lsof -ti:8080 | xargs kill -9 || true
	@lsof -ti:5173 | xargs kill -9 || true
	@echo "Killed processes on ports 8080 and 5173"
