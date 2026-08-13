const NotificationRepository = require('../repositories/notification-repository');
const EventRepository = require('../repositories/event-repository');

const NotificationService = {
    publish: (type, message, refId = null, priority = 'Medium', expiryDays = null) => {
        let expiryDate = null;
        if (expiryDays) {
            const date = new Date();
            date.setDate(date.getDate() + expiryDays);
            expiryDate = date.toISOString().split('T')[0];
        }
        
        const noteId = NotificationRepository.createNotification(type, message, refId, priority, expiryDate);
        
        // Log event
        EventRepository.logEvent('NotificationCreated', noteId, { type, message, refId, priority });
        
        return noteId;
    },
    getNotifications: (unreadOnly = true) => {
        return NotificationRepository.getNotifications(unreadOnly);
    },
    markAsRead: (id, operator = 'System', role = 'System') => {
        NotificationRepository.markRead(id);
        EventRepository.logEvent('NotificationRead', id, {}, operator, role, 'Notification marked as read');
    },
    dismissAll: (operator = 'System', role = 'System') => {
        NotificationRepository.dismissAll();
        EventRepository.logEvent('AllNotificationsDismissed', 'all', {}, operator, role, 'All active notifications dismissed');
    }
};

module.exports = NotificationService;
