# Database Schema Review Notes

## Overview
This document summarizes the current database schema review for the workforce system. The goal is to identify tables, columns, and patterns that are still useful versus those that appear redundant, legacy, or not actively used by the current application.

## What looks useful
These parts are still relevant to the current system:

- employees
- attendance
- leaves
- roles
- positions
- staffing_requirements
- shift_assignments
- employee_fingerprints
- fingerprint_enrollment_requests
- employee_inactivity_logs
- driver_inactivity_logs
- driver_availability_overrides
- employee_reassignments

These tables support core features such as employee records, attendance tracking, leave management, scheduling, staffing, fingerprint enrollment, and driver availability handling.

## Parts that look unnecessary or outdated
The following schema pieces appear to be weak candidates for continued use:

- shift_coverage
  - Seems redundant because the system already uses employee_reassignments for coverage and replacement tracking.

- shift_requirements
  - Appears to be an older or alternate version of staffing requirements and is not used by the current backend flow.

- role_requirements
  - Does not appear to be used by the current application logic.

- roles.allowed_positions
  - This array field looks unnecessary because positions are already represented by the positions table.

- employees.driver_availability
  - The current logic appears to rely more on attendance, leave status, and driver_availability_overrides rather than this column.

- attendance.source_leave_id
  - This does not appear to be actively used by the current controllers.

- shift_assignments.staffing_requirement_id
  - The current code does not rely on this relationship in practice.

## Redundant or overlapping areas
Some areas overlap and could be simplified:

- drivers vs employees
  - The app uses employees as the main workforce record, while drivers is a separate table for driver-specific metadata.
  - If drivers are simply employees with a specific role, this separation may be more complex than needed.

- employee_reassignments vs shift_coverage
  - Both represent replacement/coverage logic, but the current system mainly uses employee_reassignments.

- staffing_requirements vs other requirement tables
  - staffing_requirements is the one currently used by the app; the other requirement-style tables seem to be older abstractions.

## Recommendation
For a cleaner and easier-to-maintain schema, it would be reasonable to:

1. Remove or deprecate the clearly unused tables and columns.
2. Keep the core operational tables that support attendance, leaves, scheduling, staffing, fingerprinting, and availability rules.
3. Consider simplifying the driver and coverage model if the business rules allow it.

## Conclusion
The schema is not completely useless, but it contains several legacy or redundant pieces. The best next step is to trim the unused complexity and keep only the structures that are actively supporting the current system.
