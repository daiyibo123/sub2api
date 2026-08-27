// Package routes provides HTTP route registration and handlers.
package routes

import (
	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

// RegisterUserRoutes 注册用户相关路由（精简版）
// 仅保留：API Key 管理、使用记录、基础个人资料
func RegisterUserRoutes(
	v1 *gin.RouterGroup,
	h *handler.Handlers,
	_ middleware.JWTAuthMiddleware,
	_ middleware.AuditLogMiddleware,
	_ *service.SettingService,
	_ *middleware.PanelRateLimiter,
) {
	authenticated := v1.Group("")
	authenticated.Use(middleware.BackendModeUserGuard(settingService))
	{
		// API Key 管理
		keys := authenticated.Group("/keys")
		{
			keys.GET("", h.APIKey.List)
			keys.GET("/:id", h.APIKey.GetByID)
			keys.POST("", h.APIKey.Create)
			keys.PUT("/:id", h.APIKey.Update)
			keys.DELETE("/:id", h.APIKey.Delete)
		}

		// 使用记录
		usage := authenticated.Group("/usage")
		{
			usage.GET("", h.Usage.List)
			usage.GET("/:id", h.Usage.GetByID)
			usage.GET("/stats", h.Usage.Stats)
		}
	}
}
