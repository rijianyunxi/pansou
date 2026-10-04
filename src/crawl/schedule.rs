use super::Settings;
use crate::error::ApiError;
use chrono::{DateTime, FixedOffset, Utc};
use croner::Cron;
use croner::parser::{CronParser, Seconds, Year};

/// The second/minute fields schedule starts; hour/date fields also limit subsequent
/// incremental pages. Historical backfill and the initial head page bypass it.
pub struct DailySchedule {
    cron: Cron,
    active_hours: Cron,
}

impl DailySchedule {
    pub fn new(settings: &Settings) -> Result<std::sync::Arc<Self>, ApiError> {
        // Cache by expression, not process-local revision: separate databases and
        // tests can legitimately reuse a version with different expressions.
        static CACHE: std::sync::OnceLock<
            std::sync::Mutex<Option<(String, std::sync::Arc<DailySchedule>)>>,
        > = std::sync::OnceLock::new();
        let mut cached = CACHE
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some((expression, schedule)) = cached.as_ref() {
            if expression == &settings.daily_cron {
                return Ok(schedule.clone());
            }
        }
        let schedule = std::sync::Arc::new(Self::from_expression(&settings.daily_cron)?);
        *cached = Some((settings.daily_cron.clone(), schedule.clone()));
        Ok(schedule)
    }

    pub fn from_expression(expression: &str) -> Result<Self, ApiError> {
        let fields = expression.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 6 || expression.len() > 200 {
            return Err(ApiError::BadRequest(
                "cron 须为六段：秒 分 时 日 月 周；按北京时间执行".into(),
            ));
        }
        let parse = |value: &str| {
            CronParser::builder()
                .seconds(Seconds::Required)
                .year(Year::Disallowed)
                .build()
                .parse(value)
                .map_err(|_| ApiError::BadRequest("cron 表达式无效".into()))
        };
        Ok(Self {
            cron: parse(expression)?,
            active_hours: parse(&format!("* * {}", fields[2..].join(" ")))?,
        })
    }

    pub fn allows_pages(&self, now: DateTime<Utc>) -> bool {
        self.active_hours
            .is_time_matching(&now.with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap()))
            .unwrap_or(false)
    }

    pub fn next_after(&self, now: DateTime<Utc>) -> Result<DateTime<Utc>, ApiError> {
        self.cron
            .find_next_occurrence(
                &now.with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap()),
                false,
            )
            .map(|time| time.with_timezone(&Utc))
            .map_err(|_| ApiError::BadRequest("cron 没有可执行的下次时间".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn schedule(expression: &str) -> std::sync::Arc<DailySchedule> {
        DailySchedule::new(&Settings {
            concurrent_channels: 3,
            page_delay_seconds: 3,
            daily_cron: expression.into(),
            version: 1,
        })
        .unwrap()
    }
    fn utc(value: &str) -> DateTime<Utc> {
        value.parse().unwrap()
    }

    #[test]
    fn shanghai_daytime_cron_skips_night_and_excludes_22() {
        let plan = schedule("0 */10 8-21 * * *");
        assert_eq!(
            plan.next_after(utc("2026-10-04T23:59:00Z")).unwrap(),
            utc("2026-10-05T00:00:00Z")
        );
        assert_eq!(
            plan.next_after(utc("2026-10-05T00:00:00Z")).unwrap(),
            utc("2026-10-05T00:10:00Z")
        );
        assert_eq!(
            plan.next_after(utc("2026-10-05T13:50:00Z")).unwrap(),
            utc("2026-10-06T00:00:00Z")
        );
        assert!(plan.allows_pages(utc("2026-10-05T13:59:59Z")));
        assert!(!plan.allows_pages(utc("2026-10-05T14:00:00Z")));
        assert!(!plan.allows_pages(utc("2026-10-04T23:59:59Z")));
    }

    #[test]
    fn pages_continue_between_cron_minutes_and_respect_weekdays() {
        let plan = schedule("0 */10 8-21 * * MON-FRI");
        assert!(plan.allows_pages(utc("2026-10-05T00:03:27Z")));
        assert!(!plan.allows_pages(utc("2026-10-04T00:10:00Z")));
        let night = schedule("0 */10 22-23,0-7 * * *");
        assert!(night.allows_pages(utc("2026-10-05T15:00:00Z")));
        assert!(!night.allows_pages(utc("2026-10-05T01:00:00Z")));
    }

    #[test]
    fn invalid_and_impossible_cron_are_rejected() {
        let mut settings = Settings {
            concurrent_channels: 3,
            page_delay_seconds: 3,
            daily_cron: "0 */10 * * * *".into(),
            version: 1,
        };
        for expression in [
            "invalid",
            "*/10 8-21 * * *",
            "0 0 */10 8-21 * * *",
            "61 * * * * *",
        ] {
            settings.daily_cron = expression.into();
            assert!(DailySchedule::new(&settings).is_err());
        }
        settings.daily_cron = "0 0 8 30 2 *".into();
        assert!(
            DailySchedule::new(&settings)
                .unwrap()
                .next_after(utc("2026-10-04T00:00:00Z"))
                .is_err()
        );
    }
}
