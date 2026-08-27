// Package server provides HTTP server setup and configuration.
package server

import (
	"context"
	"log"
	"sync/atomic"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/handler"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/server/routes"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/Wei-Shaw/sub2api/internal/web"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

// SetupRouter 配置路由器中间件和路由（精简版）
func SetupRouter(
	r *gin.Engine,
	h *handler.Handlers,
	jwtAuth middleware2.JWTAuthMiddleware,
	_ middleware2.OptionalJWTAuthMiddleware,
	adminAuth middleware2.AdminAuthMiddleware,
	apiKeyAuth middleware2.APIKeyAuthMiddleware,
	_ middleware2.AuditLogMiddleware,
	_ middleware2.StepUpAuthMiddleware,
	apiKeyService *service.APIKeyService,
	_ *service.SubscriptionService,
	opsService *service.OpsService,
	settingService *service.SettingService,
	compositeResolver *service.CompositeRouteResolver,
	cfg *config.Config,
	redisClient *redis.Client,
) *gin.Engine {
	// 基础中间件
	r.Use(middleware2.RequestLogger())
	r.Use(middleware2.SessionBindingContext(cfg))
	r.Use(middleware2.Logger())
	r.Use(middleware2.CORS(cfg.CORS))
	r.Use(middleware2.SecurityHeaders(cfg.Security.CSP, nil))
	r.Use(middleware2.ServerTiming(cfg.Server.EnableServerTiming))

	// 注册路由
	registerRoutes(r, h, jwtAuth, adminAuth, apiKeyAuth, apiKeyService, opsService, settingService, compositeResolver, cfg, redisClient)

	return r
}

// registerRoutes 注册所有 HTTP 路由（精简版）
func registerRoutes(
	r *gin.Engine,
	h *handler.Handlers,
	_ middleware2.JWTAuthMiddleware,
	adminAuth middleware2.AdminAuthMiddleware,
	apiKeyAuth middleware2.APIKeyAuthMiddleware,
	apiKeyService *service.APIKeyService,
	opsService *service.OpsService,
	settingService *service.SettingService,
	compositeResolver *service.CompositeRouteResolver,
	cfg *config.Config,
	redisClient *redis.Client,
) {
	// 通用路由
	routes.RegisterCommonRoutes(r)

	// API v1
	v1 := r.Group("/api/v1")

	// 注册各模块路由
	routes.RegisterAuthRoutes(v1, h, nil, nil, nil, nil, nil)
	routes.RegisterUserRoutes(v1, h, nil, nil, nil, nil)
	routes.RegisterAdminRoutes(v1, h, adminAuth, nil, nil, nil, nil)
	routes.RegisterGatewayRoutes(r, h, apiKeyAuth, apiKeyService, nil, opsService, settingService, compositeResolver, cfg)
}
