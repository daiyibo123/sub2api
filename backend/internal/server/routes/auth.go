// Package routes provides HTTP route registration and handlers.
package routes

import (
	"time"

	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/middleware"
	servermiddleware "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

// RegisterAuthRoutes 注册认证相关路由（精简版）
// 仅保留：登录、登出、当前用户信息、公开设置
func RegisterAuthRoutes(
	v1 *gin.RouterGroup,
	h *handler.Handlers,
	_ middleware.JWTAuthMiddleware,
	_ middleware.AuditLogMiddleware,
	_ *redis.Client,
	_ *service.SettingService,
	_ *servermiddleware.PanelRateLimiter,
) {
	auth := v1.Group("/auth")
	{
		// 登录
		auth.POST("/login", h.Auth.Login)
		// 登出
		auth.POST("/logout", h.Auth.Logout)
		// 当前用户信息
		auth.GET("/me", h.Auth.GetCurrentUser)
	}

	// 公开设置（无需认证）
	settings := v1.Group("/settings")
	{
		settings.GET("/public", h.Setting.GetPublicSettings)
	}
}
