// Package routes provides HTTP route registration and handlers.
package routes

import (
	"github.com/Wei-Shaw/sub2api/internal/handler"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
)

// RegisterAdminRoutes 注册管理员路由（精简版）
// 仅保留核心功能：仪表盘、分组、渠道、账号管理
func RegisterAdminRoutes(
	v1 *gin.RouterGroup,
	h *handler.Handlers,
	adminAuth middleware.AdminAuthMiddleware,
	_ middleware.AuditLogMiddleware,
	_ middleware.StepUpAuthMiddleware,
	_ *service.SettingService,
	_ *middleware.PanelRateLimiter,
) {
	admin := v1.Group("/admin")
	admin.Use(gin.HandlerFunc(adminAuth))
	{
		// 仪表盘
		registerDashboardRoutes(admin, h)

		// 分组管理
		registerGroupRoutes(admin, h)

		// 渠道管理
		registerChannelRoutes(admin, h)

		// 账号管理
		registerAccountRoutes(admin, h)
	}
}

func registerDashboardRoutes(admin *gin.RouterGroup, h *handler.Handlers) {
	dashboard := admin.Group("/dashboard")
	{
		dashboard.GET("/stats", h.Admin.Dashboard.GetStats)
		dashboard.GET("/realtime", h.Admin.Dashboard.GetRealtimeMetrics)
	}
}

func registerGroupRoutes(admin *gin.RouterGroup, h *handler.Handlers) {
	groups := admin.Group("/groups")
	{
		groups.GET("", h.Admin.Group.List)
		groups.GET("/:id", h.Admin.Group.GetByID)
		groups.POST("", h.Admin.Group.Create)
		groups.PUT("/:id", h.Admin.Group.Update)
		groups.DELETE("/:id", h.Admin.Group.Delete)
	}
}

func registerChannelRoutes(admin *gin.RouterGroup, h *handler.Handlers) {
	channels := admin.Group("/channels")
	{
		channels.GET("", h.Admin.Channel.List)
		channels.GET("/:id", h.Admin.Channel.GetByID)
		channels.POST("", h.Admin.Channel.Create)
		channels.PUT("/:id", h.Admin.Channel.Update)
		channels.DELETE("/:id", h.Admin.Channel.Delete)
	}
}

func registerAccountRoutes(admin *gin.RouterGroup, h *handler.Handlers) {
	accounts := admin.Group("/accounts")
	{
		accounts.GET("", h.Admin.Account.List)
		accounts.GET("/:id", h.Admin.Account.GetByID)
		accounts.POST("", h.Admin.Account.Create)
		accounts.PUT("/:id", h.Admin.Account.Update)
		accounts.DELETE("/:id", h.Admin.Account.Delete)
		accounts.POST("/:id/test", h.Admin.Account.Test)
		accounts.POST("/:id/clear-error", h.Admin.Account.ClearError)
	}
}
