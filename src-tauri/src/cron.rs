//! Minimal 5-field cron (`minute hour day-of-month month day-of-week`) in local time.
//!
//! Supports `*`, numbers, lists (`1,15`), ranges (`1-5`) and steps (`*/15`,
//! `0-30/10`). Day-of-week is 0-6 with Sunday = 0 (7 also means Sunday). When
//! both day fields are restricted, a day matches if either matches (classic
//! cron). Good enough for job schedules; no seconds, no `L`/`W`/`#`.

use chrono::{DateTime, Datelike, Duration, Local, TimeZone, Timelike};

#[derive(Clone, Debug, PartialEq)]
pub struct Cron {
    minutes: Vec<bool>,
    hours: Vec<bool>,
    dom: Vec<bool>,
    months: Vec<bool>,
    dow: Vec<bool>,
    dom_any: bool,
    dow_any: bool,
}

fn parse_field(s: &str, lo: u32, hi: u32) -> Result<(Vec<bool>, bool), String> {
    let mut set = vec![false; hi as usize + 1];
    let any = s == "*";
    for part in s.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, st)) => (r, st.parse::<u32>().map_err(|_| format!("bad step in {part:?}"))?),
            None => (part, 1),
        };
        if step == 0 {
            return Err(format!("step must be > 0 in {part:?}"));
        }
        let (a, b) = if range == "*" {
            (lo, hi)
        } else if let Some((x, y)) = range.split_once('-') {
            (x.parse().map_err(|_| format!("bad number in {part:?}"))?, y.parse().map_err(|_| format!("bad number in {part:?}"))?)
        } else {
            let v: u32 = range.parse().map_err(|_| format!("bad number in {part:?}"))?;
            (v, if part.contains('/') { hi } else { v })
        };
        if a < lo || b > hi || a > b {
            return Err(format!("{part:?} is outside {lo}-{hi}"));
        }
        let mut v = a;
        while v <= b {
            set[v as usize] = true;
            v += step;
        }
    }
    Ok((set, any))
}

impl Cron {
    pub fn parse(expr: &str) -> Result<Cron, String> {
        let f: Vec<&str> = expr.split_whitespace().collect();
        if f.len() != 5 {
            return Err("a schedule needs 5 fields: minute hour day month weekday".into());
        }
        let (minutes, _) = parse_field(f[0], 0, 59)?;
        let (hours, _) = parse_field(f[1], 0, 23)?;
        let (dom, dom_any) = parse_field(f[2], 1, 31)?;
        let (months, _) = parse_field(f[3], 1, 12)?;
        let (mut dow, dow_any) = parse_field(f[4], 0, 7)?;
        if dow[7] {
            dow[0] = true;
        }
        dow.truncate(7);
        Ok(Cron { minutes, hours, dom, months, dow, dom_any, dow_any })
    }

    fn day_matches(&self, t: &DateTime<Local>) -> bool {
        let dom = self.dom[t.day() as usize];
        let dow = self.dow[t.weekday().num_days_from_sunday() as usize];
        match (self.dom_any, self.dow_any) {
            (true, true) => true,
            (true, false) => dow,
            (false, true) => dom,
            (false, false) => dom || dow,
        }
    }

    pub fn matches(&self, t: &DateTime<Local>) -> bool {
        self.minutes[t.minute() as usize] && self.hours[t.hour() as usize] && self.months[t.month() as usize] && self.day_matches(t)
    }

    /// First matching minute strictly after `after`, within ~2 years.
    pub fn next_after(&self, after: DateTime<Local>) -> Option<DateTime<Local>> {
        let start = after.with_second(0)?.with_nanosecond(0)? + Duration::minutes(1);
        let mut t = start;
        let limit = start + Duration::days(366 * 2);
        while t < limit {
            if !self.months[t.month() as usize] || !self.day_matches(&t) {
                // jump to the next day's midnight (DST-safe via local re-resolution)
                let next = (t.date_naive() + Duration::days(1)).and_hms_opt(0, 0, 0)?;
                t = Local.from_local_datetime(&next).earliest()?;
                continue;
            }
            if !self.hours[t.hour() as usize] {
                t = t.with_minute(0)? + Duration::hours(1);
                continue;
            }
            if self.minutes[t.minute() as usize] {
                return Some(t);
            }
            t += Duration::minutes(1);
        }
        None
    }
}

/// Human description for the common shapes produced by the job editor.
pub fn describe(expr: &str) -> String {
    let f: Vec<&str> = expr.split_whitespace().collect();
    if f.len() != 5 {
        return expr.to_string();
    }
    let time = |h: &str, m: &str| match (h.parse::<u32>(), m.parse::<u32>()) {
        (Ok(h), Ok(m)) => Some(format!("{h:02}:{m:02}")),
        _ => None,
    };
    let days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    match (f[0], f[1], f[2], f[3], f[4]) {
        ("0", "*", "*", "*", "*") => "every hour".into(),
        (m, "*", "*", "*", "*") if m.starts_with("*/") => format!("every {} minutes", &m[2..]),
        (m, h, "*", "*", "*") if time(h, m).is_some() => format!("daily at {}", time(h, m).unwrap()),
        (m, h, "*", "*", "1-5") if time(h, m).is_some() => format!("weekdays at {}", time(h, m).unwrap()),
        (m, h, "*", "*", d) if time(h, m).is_some() && d.parse::<usize>().map_or(false, |d| d <= 7) => {
            format!("every {} at {}", days[d.parse::<usize>().unwrap() % 7], time(h, m).unwrap())
        }
        (m, h, dom, "*", "*") if time(h, m).is_some() && dom.parse::<u32>().is_ok() => format!("monthly on day {dom} at {}", time(h, m).unwrap()),
        _ => format!("cron {expr}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).earliest().unwrap()
    }

    #[test]
    fn next_runs_for_common_schedules() {
        let daily = Cron::parse("30 9 * * *").unwrap();
        assert_eq!(daily.next_after(at(2026, 10, 1, 8, 0)), Some(at(2026, 10, 1, 9, 30)));
        assert_eq!(daily.next_after(at(2026, 10, 1, 9, 30)), Some(at(2026, 10, 2, 9, 30)), "strictly after");

        let weekdays = Cron::parse("0 8 * * 1-5").unwrap();
        // 2026-10-03 is a Saturday -> next is Monday 5th
        assert_eq!(weekdays.next_after(at(2026, 10, 3, 12, 0)), Some(at(2026, 10, 5, 8, 0)));

        let every15 = Cron::parse("*/15 * * * *").unwrap();
        assert_eq!(every15.next_after(at(2026, 10, 1, 10, 7)), Some(at(2026, 10, 1, 10, 15)));

        let sunday = Cron::parse("0 18 * * 7").unwrap();
        assert_eq!(sunday.next_after(at(2026, 10, 1, 0, 0)), Some(at(2026, 10, 4, 18, 0)), "7 = Sunday");

        let monthly = Cron::parse("0 9 1 * *").unwrap();
        assert_eq!(monthly.next_after(at(2026, 10, 2, 0, 0)), Some(at(2026, 11, 1, 9, 0)));
    }

    #[test]
    fn rejects_bad_expressions() {
        assert!(Cron::parse("* * * *").is_err());
        assert!(Cron::parse("60 * * * *").is_err());
        assert!(Cron::parse("*/0 * * * *").is_err());
        assert!(Cron::parse("a * * * *").is_err());
        assert!(Cron::parse("5-1 * * * *").is_err());
    }

    #[test]
    fn describes_editor_presets() {
        assert_eq!(describe("0 * * * *"), "every hour");
        assert_eq!(describe("30 9 * * *"), "daily at 09:30");
        assert_eq!(describe("0 8 * * 1-5"), "weekdays at 08:00");
        assert_eq!(describe("0 18 * * 0"), "every Sunday at 18:00");
        assert_eq!(describe("*/15 * * * *"), "every 15 minutes");
        assert_eq!(describe("0 9 1 * *"), "monthly on day 1 at 09:00");
        assert_eq!(describe("5 4 * 2 1"), "cron 5 4 * 2 1");
    }
}
